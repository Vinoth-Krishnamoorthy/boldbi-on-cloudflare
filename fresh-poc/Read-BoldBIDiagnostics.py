"""Read-only diagnostics executed inside the existing BoldBI container."""
import datetime
import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import socket
import ssl
from urllib.parse import urlsplit


def safe_line(line):
    if re.search(r"password\s*[=:]|authorization|bearer\s|connection\s*string|\bpwd\s*=|\buser\s+id\s*=|POC_TUNNEL_TOKEN|POSTGRES_PASSWORD", line, re.I):
        return "[Potentially sensitive line omitted]"
    return re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[redacted]", line)[:2000]


def proxy_configuration():
    # exec() inherits no application environment. Read only these two startup
    # settings from our own container's PID 1; never return the token or other
    # environment entries. No host-side processes or credentials are inspected.
    settings = {}
    try:
        with open("/proc/1/environ", "rb") as stream:
            for entry in stream.read(1048576).split(b"\0"):
                key, _, value = entry.partition(b"=")
                if key in (b"POC_TUNNEL_URL", b"POC_TUNNEL_TOKEN"):
                    settings[key.decode()] = value.decode("utf-8", errors="replace")
    except OSError:
        return {"proxyStartupConfigurationReadable": False}, None, None
    token = settings.get("POC_TUNNEL_TOKEN", "")
    expected = os.environ.get("POC_EXPECTED_TOKEN_SHA256", "")
    details = {
        "proxyStartupConfigurationReadable": True,
        "proxyTokenPresent": len(token) >= 32,
        "proxyTokenMatchesWorker": hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), expected) if expected and token else None,
    }
    try:
        endpoint = urlsplit(settings.get("POC_TUNNEL_URL", ""))
        allowed = (
            endpoint.scheme == "https" and endpoint.hostname == "ticket287457.synctest.workers.dev"
            and endpoint.port in (None, 443) and not endpoint.username and not endpoint.password
            and endpoint.path == "/_poc/postgres/tunnel" and not endpoint.query and not endpoint.fragment
        )
        details.update(tunnelHost=endpoint.hostname, tunnelPath=endpoint.path, tunnelEndpointAllowed=allowed)
        return details, endpoint if allowed else None, token
    except ValueError:
        details["tunnelEndpointAllowed"] = False
        return details, None, token


def transport_error(error):
    # Classify errors without exposing request headers, tokens, or response data.
    if isinstance(error, ssl.SSLCertVerificationError):
        return "TLS certificate verification failed"
    if isinstance(error, ssl.SSLError):
        return "TLS handshake failed"
    if isinstance(error, socket.gaierror):
        return "DNS lookup failed"
    if isinstance(error, TimeoutError):
        return "Connection timed out"
    if isinstance(error, ConnectionRefusedError):
        return "Connection refused"
    if isinstance(error, ConnectionResetError):
        return "Connection reset by peer"
    return type(error).__name__


def probe_upstream(endpoint, token, upgrade=False):
    prefix = "directWebSocket" if upgrade else "directHealth"
    connection = None
    try:
        connection = http.client.HTTPSConnection(endpoint.hostname, timeout=6, context=ssl.create_default_context())
        headers = {"Authorization": "Bearer " + token}
        path = "/_poc/postgres/health"
        if upgrade:
            path = "/_poc/postgres/tunnel"
            key = base64.b64encode(os.urandom(16)).decode()
            headers.update({"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key})
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        details = {prefix + "HttpStatus": response.status}
        if upgrade and response.status == 101:
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            details[prefix + "UpgradeValid"] = hmac.compare_digest(response.getheader("Sec-WebSocket-Accept", ""), accept)
        return details
    except (OSError, http.client.HTTPException) as error:
        return {prefix + "Error": transport_error(error)}
    finally:
        if connection is not None:
            connection.close()


def main():
    result = {
        "timestampUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "caBundlePresent": os.path.isfile("/etc/ssl/certs/ca-certificates.crt"),
    }
    details, endpoint, token = proxy_configuration()
    result.update(details)
    if endpoint and token:
        result.update(probe_upstream(endpoint, token))
        result.update(probe_upstream(endpoint, token, upgrade=True))
    # PostgreSQL SSLRequest. 'N' means this POC server does not offer database
    # TLS; either 'N' or 'S' proves bytes passed through BoldBI's local proxy
    # to a PostgreSQL endpoint and back. This does not test database passwords.
    try:
        with socket.create_connection(("127.0.0.1", 15432), timeout=8) as connection:
            connection.settimeout(10)
            connection.sendall(bytes([0, 0, 0, 8, 4, 210, 22, 47]))
            reply = connection.recv(1)
        result["postgresProtocolReply"] = reply.decode("ascii", errors="replace")
        result["boldbiProxyReachedPostgres"] = reply in (b"N", b"S")
    except OSError as error:
        result["boldbiProxyReachedPostgres"] = False
        result["proxyError"] = safe_line(str(error))

    root = "/application/app_data/logs"
    result["logDirectoryExists"] = os.path.isdir(root)
    candidates = []
    for directory, children, filenames in os.walk(root):
        if os.path.relpath(directory, root).count(os.sep) >= 6:
            children[:] = []
        for name in filenames:
            # Read logs only, never application settings or database files.
            if not name.lower().endswith((".log", ".txt")):
                continue
            path = os.path.join(directory, name)
            try:
                if os.path.isfile(path) and not os.path.islink(path):
                    candidates.append((os.path.getmtime(path), path))
            except OSError:
                pass
    result["applicationLogs"] = []
    for modified, path in sorted(candidates, reverse=True)[:10]:
        try:
            with open(path, "rb") as stream:
                stream.seek(max(0, os.fstat(stream.fileno()).st_size - 65536))
                lines = stream.read().decode("utf-8", errors="replace").splitlines()[-120:]
            relevant = [safe_line(line) for line in lines if re.search(
                r"database|postgres|npgsql|exception|error|fail|socket|connection|^\s+at ", line, re.I
            )]
            result["applicationLogs"].append({
                "file": os.path.relpath(path, root),
                "modifiedUtc": datetime.datetime.fromtimestamp(modified, datetime.timezone.utc).isoformat(),
                "errorLines": relevant[-60:],
            })
        except OSError as error:
            result["applicationLogs"].append({"file": os.path.relpath(path, root), "error": safe_line(str(error))})
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
