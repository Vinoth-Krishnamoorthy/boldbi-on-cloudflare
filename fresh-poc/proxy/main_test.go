package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "test-token-with-more-than-thirty-two-characters"

func TestTunnelReportsUntrustedCertificateWithoutLeakingCredentials(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	_, err := dialTunnel(context.Background(), server.URL+tunnelPath, testToken)
	if err == nil || !strings.Contains(err.Error(), "CA certificate bundle") {
		t.Fatalf("expected an untrusted CA diagnostic, got %v", err)
	}
	if strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), server.URL) {
		t.Fatal("diagnostic disclosed a token or endpoint")
	}
}

func TestTunnelTransportErrorCategories(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{x509.HostnameError{}, "hostname mismatch"},
		{&net.DNSError{Err: "no such host", Name: "private-host"}, "DNS lookup failed"},
		{context.DeadlineExceeded, "timed out"},
	} {
		// A wrapped URL error must never cause the URL or query secret to leak.
		wrapped := fmt.Errorf("dial failed: %w", &url.Error{Op: "Get", URL: "https://private/?token=" + testToken, Err: tc.err})
		actual := tunnelTransportError(wrapped).Error()
		if !strings.Contains(actual, tc.want) || strings.Contains(actual, testToken) || strings.Contains(actual, "private") {
			t.Fatalf("unexpected diagnostic: %s", actual)
		}
	}
}

func echoTarget(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	accepted := &atomic.Int32{}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	return listener.Addr().String(), accepted
}

func TestServerRejectsUnauthorizedRequestsBeforeDial(t *testing.T) {
	target, accepted := echoTarget(t)
	server := httptest.NewServer(serverHandler(context.Background(), testToken, target))
	defer server.Close()
	for _, token := range []string{"", "wrong-token"} {
		req, _ := http.NewRequest("GET", server.URL+healthPath, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("got status %d", response.StatusCode)
		}
	}
	if accepted.Load() != 0 {
		t.Fatal("unauthorized request reached backend")
	}
}

func TestAuthenticatedHealthAndRestrictions(t *testing.T) {
	target, _ := echoTarget(t)
	handler := serverHandler(context.Background(), testToken, target)
	for _, tc := range []struct {
		path, method, origin string
		status               int
	}{
		{healthPath, "GET", "", 200},
		{healthPath, "POST", "", 405},
		{"/arbitrary-target", "GET", "", 404},
		{tunnelPath, "GET", "https://browser.example", 403},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		req.Header.Set("Origin", tc.origin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != tc.status {
			t.Fatalf("%s: got %d, want %d", tc.path, response.Code, tc.status)
		}
	}
}

func TestClientServerRoundTripAndAuthentication(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	target, _ := echoTarget(t)
	server := httptest.NewServer(serverHandler(ctx, testToken, target))
	defer server.Close()
	if ws, err := dialTunnel(ctx, server.URL+tunnelPath, "wrong-token"); err == nil {
		ws.CloseNow()
		t.Fatal("invalid token accepted")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go serveClient(ctx, listener, server.URL+tunnelPath, testToken)
	for i := 0; i < 4; i++ {
		t.Run("binary-stream", func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
			payload := make([]byte, 1024*1024+17)
			_, _ = rand.Read(payload)
			written := make(chan error, 1)
			go func() { _, err := io.Copy(conn, bytes.NewReader(payload)); written <- err }()
			actual := make([]byte, len(payload))
			if _, err := io.ReadFull(conn, actual); err != nil {
				t.Fatal(err)
			}
			if err := <-written; err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(payload, actual) {
				t.Fatal("binary PostgreSQL stream was changed")
			}
		})
	}
}

func TestBackendUnavailable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := listener.Addr().String()
	listener.Close()
	req := httptest.NewRequest("GET", healthPath, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	response := httptest.NewRecorder()
	serverHandler(context.Background(), testToken, target).ServeHTTP(response, req)
	if response.Code != 503 {
		t.Fatalf("got %d", response.Code)
	}
}
