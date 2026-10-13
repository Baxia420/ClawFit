// Preloaded before the real CLI and retained through every respawn. Tests have
// no live gateway/model/database transport, including during module startup.
import { Socket, Server } from "node:net";
Socket.prototype.connect = function () { throw new Error("Network disabled in offline CLI fixture"); };
Server.prototype.listen = function () { throw new Error("Server binding disabled in offline CLI fixture"); };
