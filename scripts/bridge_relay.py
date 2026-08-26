"""Bridge the reverse tunnel into Docker's network.

The tunnel from the PC can only bind to 127.0.0.1 on this host — sshd's
GatewayPorts is off and changing it means editing a system config and restarting
sshd, which is not worth it for this. Containers cannot reach the host's
loopback, so this listens on the docker bridge and forwards to it.

Small on purpose: no dependencies, no privileges, and it dies with the shell
that started it. If the tunnel is down, connections here fail immediately, which
is precisely the signal the speech service needs to fall back to its own CPU.
"""
import os
import selectors
import socket
import threading

LISTEN = (os.getenv("RELAY_HOST", "172.19.0.1"), int(os.getenv("RELAY_PORT", "4500")))
TARGET = ("127.0.0.1", int(os.getenv("TARGET_PORT", "4500")))
CONNECT_TIMEOUT = float(os.getenv("RELAY_CONNECT_TIMEOUT", "2"))


def pump(a, b):
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            s.close()


def serve(client):
    try:
        upstream = socket.create_connection(TARGET, timeout=CONNECT_TIMEOUT)
    except OSError:
        client.close()          # tunnel is down: fail fast, do not hang
        return
    # The connect is bounded; the conversation is not. A long synthesis sends
    # nothing for a minute or more, and that silence must not look like failure.
    for sock in (upstream, client):
        sock.settimeout(None)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pump, args=(upstream, client), daemon=True).start()


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(LISTEN)
srv.listen(64)
print(f"мост слушает {LISTEN[0]}:{LISTEN[1]} -> {TARGET[0]}:{TARGET[1]}", flush=True)

sel = selectors.DefaultSelector()
sel.register(srv, selectors.EVENT_READ)
while True:
    for key, _ in sel.select():
        conn, _ = srv.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()
