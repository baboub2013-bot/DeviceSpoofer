/*
 * DeviceSpoofer - Vencord user plugin
 * Copyright (c) 2026 Babou
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Changes Discord Gateway IDENTIFY client properties, not hardware identifiers.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";

type Platform = "off" | "desktop" | "web" | "android" | "ios" | "vr";
type ClientProperties = { os: string; browser: string; device: string; };

type GatewaySocket = {
    send: (...args: any[]) => any;
    sessionId?: string | null;
    seq?: number | null;
    webSocket?: WebSocket | null;
    close?: () => void;
    connect?: () => void;
};

const profiles: Record<Exclude<Platform, "off">, ClientProperties> = {
    desktop: { os: "Windows", browser: "Discord Client", device: "" },
    web: { os: "Windows", browser: "Chrome", device: "" },
    android: { os: "Android", browser: "Discord Android", device: "Discord Android" },
    ios: { os: "iOS", browser: "Discord iOS", device: "Discord iOS" },
    // Keep the user-confirmed Meta Quest profile unchanged.
    vr: { os: "Android", browser: "Discord VR", device: "Meta Quest" }
};

let running = false;
let patchedSocket: GatewaySocket | null = null;
let originalSend: GatewaySocket["send"] | null = null;

const settings = definePluginSettings({
    platform: {
        type: OptionType.SELECT,
        description: "Choose the platform Discord reports to other users. A Gateway reconnect may be required.",
        default: "off",
        restartNeeded: false,
        options: [
            { label: "Disabled (Use Real Platform)", value: "off" },
            { label: "Windows Desktop", value: "desktop" },
            { label: "Web Browser", value: "web" },
            { label: "Android Mobile", value: "android" },
            { label: "iPhone / iOS", value: "ios" },
            { label: "Meta Quest / VR", value: "vr" }
        ],
        onChange: () => {
            if (running) reconnectWithCurrentPlatform();
        }
    }
});

function getGateway(): any {
    return findByProps("getSocket", "isConnected");
}

function getSocket(): GatewaySocket | null {
    try {
        return getGateway()?.getSocket?.() ?? null;
    } catch (error) {
        console.warn("[DeviceSpoofer] Failed to access the Gateway socket", error);
        return null;
    }
}

function detach() {
    if (patchedSocket && originalSend) patchedSocket.send = originalSend;
    patchedSocket = null;
    originalSend = null;
}

function attach(socket: GatewaySocket) {
    if (patchedSocket === socket && originalSend) return;
    detach();

    if (typeof socket.send !== "function") {
        console.warn("[DeviceSpoofer] Gateway socket.send is unavailable");
        return;
    }

    const previous = socket.send;
    socket.send = function (...args: any[]) {
        const [opcode, packet] = args;
        const selected = settings.store.platform as Platform;
        const spoof = selected === "off" ? null : profiles[selected];

        // Gateway opcode 2 is IDENTIFY. RESUME does not send these properties.
        if (opcode === 2 && spoof) {
            const properties = packet?.properties ?? packet?.d?.properties;
            if (properties && typeof properties === "object") {
                Object.assign(properties, spoof);
                // Older client builds may use legacy $-prefixed properties.
                for (const key of ["os", "browser", "device"] as const) {
                    const legacyKey = "$" + key;
                    if (legacyKey in properties) properties[legacyKey] = spoof[key];
                }
                console.info("[DeviceSpoofer] Gateway IDENTIFY updated:", selected);
            } else {
                console.warn("[DeviceSpoofer] IDENTIFY packet did not contain recognized properties");
            }
        }
        return previous.apply(this, args);
    };
    patchedSocket = socket;
    originalSend = previous;
}

function reconnect(socket: GatewaySocket) {
    // A new IDENTIFY is required for platform changes to take effect.
    socket.sessionId = null;
    socket.seq = 0;
    const ws = socket.webSocket;

    if (ws && ws.readyState < WebSocket.CLOSING) {
        ws.close(1000, "DeviceSpoofer platform changed");
        return;
    }
    if (typeof socket.close === "function" && typeof socket.connect === "function") {
        socket.close();
        setTimeout(() => socket.connect?.(), 500);
        return;
    }
    console.warn("[DeviceSpoofer] Restart Discord to apply the selected platform");
}

function reconnectWithCurrentPlatform() {
    const socket = getSocket();
    if (!socket) {
        console.warn("[DeviceSpoofer] Gateway socket not found. Restart Discord");
        return;
    }
    if (running) attach(socket);
    reconnect(socket);
}

// Diagnostics expose platform/session types, never authentication tokens.
function debugStatus() {
    const socket = getSocket();
    const status = {
        selected: settings.store.platform,
        patched: socket != null && socket === patchedSocket,
        connected: Boolean(getGateway()?.isConnected?.())
    };
    console.table(status);
    return status;
}

function debugSessions() {
    const source = findByProps("getSessions");
    const sessions = source?.getSessions?.();
    if (!sessions) {
        console.warn("[DeviceSpoofer] Session data is unavailable");
        return [];
    }
    const rows = Object.values(sessions).map((session: any) => ({
        client: session?.clientInfo?.client ?? session?.client_info?.client ?? "unknown",
        os: session?.clientInfo?.os ?? session?.client_info?.os ?? "unknown"
    }));
    console.table(rows);
    return rows;
}

export default definePlugin({
    name: "DeviceSpoofer",
    description: "Change your reported Discord client platform. Includes Meta Quest / VR support.",
    authors: [{ name: "Babou", id: 0n }],
    settings,

    start() {
        // Invalid selections left by older releases return to the default.
        const selected = settings.store.platform as string;
        if (selected !== "off" && !(selected in profiles)) {
            settings.store.platform = "off";
        }

        running = true;
        const socket = getSocket();
        if (socket) attach(socket);
        else console.warn("[DeviceSpoofer] Gateway socket not found. Check Discord compatibility");

        // Optional diagnostic helpers for Discord DevTools.
        (window as any).__deviceSpoofer = {
            status: debugStatus,
            sessions: debugSessions,
            reconnect: reconnectWithCurrentPlatform
        };

        if (settings.store.platform !== "off" && socket) reconnectWithCurrentPlatform();
    },

    stop() {
        running = false;
        detach();
        delete (window as any).__deviceSpoofer;
        const socket = getSocket();
        if (socket) reconnect(socket);
    }
});
