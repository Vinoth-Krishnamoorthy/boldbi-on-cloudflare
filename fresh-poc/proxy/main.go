package main

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

const tunnelPath = "/_poc/postgres/tunnel"
const healthPath = "/_poc/postgres/health"

func authorized(r *http.Request, token string) bool {
	want := "Bearer " + token
	return len(token) >= 32 && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(want)) == 1
}

// bridge preserves binary PostgreSQL traffic, including PostgreSQL's own TLS
// negotiation. Closing either transport cancels and closes the other transport.
func bridge(ctx context.Context, tcp net.Conn, ws *websocket.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer tcp.Close()
	defer ws.CloseNow()
	stream := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	var once sync.Once
	stop := func() {
		once.Do(func() { cancel(); tcp.Close(); ws.CloseNow() })
	}
	finished := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(stream, tcp); stop(); finished <- struct{}{} }()
	go func() { _, _ = io.Copy(tcp, stream); stop(); finished <- struct{}{} }()
	select {
	case <-ctx.Done():
		stop()
	case <-finished:
		stop()
	}
}

func serverHandler(ctx context.Context, token, target string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path != tunnelPath && r.URL.Path != healthPath {
			http.NotFound(w, r)
			return
		}
		// These endpoints are for the machine proxy, not browser-originated calls.
		if r.Header.Get("Origin") != "" {
			http.Error(w, "Browser origins are not accepted", http.StatusForbidden)
			return
		}
		dialer := net.Dialer{Timeout: 5 * time.Second}
		tcp, err := dialer.DialContext(ctx, "tcp", target)
		if err != nil {
			http.Error(w, "PostgreSQL is not listening yet", http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == healthPath {
			tcp.Close()
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true,"postgresTcpReachable":true}`)
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			tcp.Close()
			return
		}
		bridge(ctx, tcp, ws)
	})
}

// Return useful failure categories without logging URLs, headers, or secrets.
func tunnelTransportError(err error) error {
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var certificate *tls.CertificateVerificationError
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.As(err, &authority):
		return errors.New("tunnel TLS certificate is not trusted; check the client's CA certificate bundle")
	case errors.As(err, &hostname):
		return errors.New("tunnel TLS certificate hostname mismatch")
	case errors.As(err, &certificate):
		return errors.New("tunnel TLS certificate verification failed")
	case errors.As(err, &dns):
		return errors.New("tunnel DNS lookup failed")
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &network) && network.Timeout():
		return errors.New("tunnel connection timed out")
	case errors.Is(err, syscall.ECONNREFUSED):
		return errors.New("tunnel TCP connection was refused")
	default:
		return errors.New("tunnel connection failed before an HTTP upgrade response")
	}
}

func dialTunnel(ctx context.Context, endpoint, token string) (*websocket.Conn, error) {
	ws, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPHeader:      http.Header{"Authorization": {"Bearer " + token}},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if response != nil {
			if response.StatusCode == http.StatusSwitchingProtocols {
				return nil, errors.New("tunnel WebSocket upgrade validation failed")
			}
			return nil, fmt.Errorf("tunnel returned HTTP %d", response.StatusCode)
		}
		return nil, tunnelTransportError(err)
	}
	return ws, nil
}

func serveClient(ctx context.Context, listener net.Listener, endpoint, token string) error {
	go func() { <-ctx.Done(); listener.Close() }()
	for {
		tcp, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer tcp.Close()
			dialCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
			ws, err := dialTunnel(dialCtx, endpoint, token)
			cancel()
			if err != nil {
				log.Print(err)
				return
			}
			bridge(ctx, tcp, ws)
		}()
	}
}

func waitForTunnel(ctx context.Context, endpoint, token string) error {
	deadline, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	for {
		attempt, end := context.WithTimeout(deadline, 120*time.Second)
		ws, err := dialTunnel(attempt, endpoint, token)
		end()
		if err == nil {
			ws.CloseNow()
			return nil
		}
		log.Printf("Waiting for database tunnel: %v", err)
		select {
		case <-deadline.Done():
			return errors.New("database tunnel was not ready within 10 minutes")
		case <-time.After(3 * time.Second):
		}
	}
}

func startProxy(ctx context.Context, mode, token string) error {
	if mode == "server" {
		srv := &http.Server{
			Addr: ":8081", Handler: serverHandler(ctx, token, "127.0.0.1:5432"),
			ReadHeaderTimeout: 10 * time.Second,
		}
		go func() { <-ctx.Done(); _ = srv.Close() }()
		return srv.ListenAndServe()
	}
	endpoint := os.Getenv("POC_TUNNEL_URL")
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Path != tunnelPath {
		return errors.New("POC_TUNNEL_URL must be an HTTPS Worker URL ending in " + tunnelPath)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:15432")
	if err != nil {
		return err
	}
	defer listener.Close()
	return serveClient(ctx, listener, endpoint, token)
}

func run(ctx context.Context, args []string) error {
	if len(args) < 2 || (args[0] != "server" && args[0] != "client") {
		return errors.New("usage: poc-proxy server|client COMMAND [ARG...]")
	}
	token := os.Getenv("POC_TUNNEL_TOKEN")
	if len(token) < 32 {
		return errors.New("POC_TUNNEL_TOKEN must contain at least 32 characters")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	proxyExit := make(chan error, 1)
	go func() { proxyExit <- startProxy(ctx, args[0], token) }()
	if args[0] == "client" {
		if err := waitForTunnel(ctx, os.Getenv("POC_TUNNEL_URL"), token); err != nil {
			return err
		}
		log.Print("Database tunnel ready; local PostgreSQL endpoint is 127.0.0.1:15432")
	}
	command := exec.Command(args[1], args[2:]...)
	command.Stdout, command.Stderr, command.Stdin = os.Stdout, os.Stderr, os.Stdin
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return err
	}
	childExit := make(chan error, 1)
	go func() { childExit <- command.Wait() }()
	var outcome error
	select {
	case outcome = <-childExit:
		return outcome
	case outcome = <-proxyExit:
	case <-ctx.Done():
	}
	cancel()
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
	select {
	case <-childExit:
	case <-time.After(20 * time.Second):
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		<-childExit
	}
	return outcome
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, os.Args[1:]); err != nil && ctx.Err() == nil {
		log.Print(err)
		os.Exit(1)
	}
}
