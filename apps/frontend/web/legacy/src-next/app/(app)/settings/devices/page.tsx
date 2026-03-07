"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type DeviceType = "web" | "mobile" | "desktop" | "extension" | string;

interface RegisteredDevice {
  device_id: string;
  device_type: DeviceType;
  device_name: string;
  is_online?: boolean;
  connected?: boolean;
  last_seen?: string;
}

interface PairingSession {
  pairing_id: string;
  code: string;
  status: string;
  created_at: string;
  expires_at: string;
  pairing_uri: string;
  qr_payload: string;
}

interface PairingSessionStatus {
  pairing_id: string;
  status: string;
  created_at?: string;
  expires_at?: string;
  linked_device_id?: string;
  linked_device_name?: string;
  linked_device_type?: string;
}

function toErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

async function parseApiError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string") {
    return (body as { detail: string }).detail;
  }
  return fallback;
}

async function fetchDevices(): Promise<RegisteredDevice[]> {
  const res = await fetch("/api/devices", { headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch devices"));
  const data = (await res.json()) as RegisteredDevice[];
  return Array.isArray(data) ? data : [];
}

async function createPairingSession(expiresInSeconds = 300): Promise<PairingSession> {
  const res = await fetch("/api/devices/pairing/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expires_in_seconds: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to create pairing session"));
  return (await res.json()) as PairingSession;
}

async function fetchPairingStatus(pairingId: string): Promise<PairingSessionStatus> {
  const res = await fetch(`/api/devices/pairing/session/${encodeURIComponent(pairingId)}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch pairing status"));
  return (await res.json()) as PairingSessionStatus;
}

async function redeemPairing(payload: {
  pairing_id: string;
  code: string;
  device_type: DeviceType;
  device_name: string;
  device_id?: string;
  fcm_token?: string;
}): Promise<void> {
  const res = await fetch("/api/devices/pairing/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to redeem pairing code"));
}

async function deleteDevice(deviceId: string): Promise<void> {
  const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to remove device"));
}

function pretty(value?: string): string {
  if (!value) return "Never";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

function buildQrImageUrl(payload: string): string {
  return `https://api.qrserver.com/v1/create-qr-code/?size=176x176&data=${encodeURIComponent(payload)}`;
}

export default function DevicesPage() {
  const qc = useQueryClient();
  const [activeSession, setActiveSession] = useState<PairingSession | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [redeemPairingId, setRedeemPairingId] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemType, setRedeemType] = useState<DeviceType>("desktop");
  const [redeemName, setRedeemName] = useState("");
  const [redeemDeviceId, setRedeemDeviceId] = useState("");
  const [redeemFcm, setRedeemFcm] = useState("");

  const devicesQuery = useQuery({
    queryKey: ["settings-devices"],
    queryFn: fetchDevices,
  });

  const pairingStatusQuery = useQuery({
    queryKey: ["pairing-status", activeSession?.pairing_id],
    queryFn: () => fetchPairingStatus(activeSession!.pairing_id),
    enabled: Boolean(activeSession?.pairing_id),
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const createPairingMutation = useMutation({
    mutationFn: createPairingSession,
    onSuccess: (session) => {
      setActiveSession(session);
      setRedeemPairingId(session.pairing_id);
      setRedeemCode(session.code);
      setErrorMessage("");
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to create pairing session")),
  });

  const redeemMutation = useMutation({
    mutationFn: redeemPairing,
    onSuccess: async () => {
      setErrorMessage("");
      await qc.invalidateQueries({ queryKey: ["settings-devices"] });
      if (activeSession?.pairing_id) {
        await qc.invalidateQueries({ queryKey: ["pairing-status", activeSession.pairing_id] });
      }
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to redeem code")),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDevice,
    onSuccess: async () => {
      setErrorMessage("");
      await qc.invalidateQueries({ queryKey: ["settings-devices"] });
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to remove device")),
  });

  const pairingStatus = pairingStatusQuery.data ?? null;
  const isLinked = pairingStatus?.status?.toLowerCase() === "linked";
  const expiresText = useMemo(
    () => pretty(activeSession?.expires_at || pairingStatus?.expires_at),
    [activeSession?.expires_at, pairingStatus?.expires_at],
  );

  useEffect(() => {
    if (!isLinked) return;
    void qc.invalidateQueries({ queryKey: ["settings-devices"] });
  }, [isLinked, qc]);

  // Pairing status: no useEffect. Query runs once when enabled (activeSession set);
  // refetchInterval: false and refetchOnWindowFocus: false prevent polling.
  // User can click "Refresh status" for manual refetch.

  return (
    <div className="p-6 max-w-5xl">
      <Link href="/settings" className="text-sm text-maroon-500 hover:underline mb-4 inline-block">
        &larr; Back to Settings
      </Link>

      <h1 className="text-lg font-semibold text-neutral-900 mb-2">Your Devices</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Securely link devices via one-time pairing code. Use QR payload in your mobile app scanner or paste the code on desktop apps.
      </p>

      {errorMessage && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      )}

      <div className="bg-white rounded-xl border border-neutral-200 p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-sm font-semibold text-neutral-900">Link New Device</h2>
          <button
            type="button"
            onClick={() => createPairingMutation.mutate(300)}
            disabled={createPairingMutation.isPending}
            className="rounded-lg bg-maroon-500 text-white text-sm font-semibold px-4 py-2 hover:bg-maroon-600 disabled:opacity-50"
          >
            {createPairingMutation.isPending ? "Generating..." : "Generate Pairing Code"}
          </button>
        </div>

        {activeSession && (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-xs text-neutral-500 mb-1">Pairing Code</div>
              <div className="text-2xl font-bold tracking-[0.2em] text-maroon-600">{activeSession.code}</div>
              <div className="text-xs text-neutral-500 mt-2">Expires: {expiresText}</div>
              <div className="text-xs text-neutral-500 mt-2">
                Status:{" "}
                <span className={isLinked ? "text-green-700 font-semibold" : "text-amber-700 font-semibold"}>
                  {pairingStatus?.status || activeSession.status}
                </span>
                <button
                  type="button"
                  onClick={() => pairingStatusQuery.refetch()}
                  className="ml-2 text-[11px] px-2 py-0.5 rounded border border-neutral-300 hover:bg-neutral-50"
                >
                  Refresh status
                </button>
              </div>
              {isLinked && (
                <div className="mt-2 text-xs text-green-700">
                  Linked: {pairingStatus?.linked_device_name} ({pairingStatus?.linked_device_type})
                </div>
              )}
            </div>

            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-xs text-neutral-500 mb-1">QR Payload / Deep Link</div>
              <div className="mb-3 rounded-lg border border-neutral-200 bg-white p-3 inline-flex">
                <img
                  src={buildQrImageUrl(activeSession.qr_payload)}
                  width={176}
                  height={176}
                  alt="Pairing QR code"
                />
              </div>
              <div className="text-xs text-neutral-700 break-all bg-neutral-50 border border-neutral-200 rounded p-2">
                {activeSession.qr_payload}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(activeSession.qr_payload);
                  }}
                  className="text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
                >
                  Copy Payload
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(activeSession.code);
                  }}
                  className="text-xs px-2 py-1 rounded border border-neutral-300 hover:bg-neutral-50"
                >
                  Copy Code
                </button>
              </div>
              <p className="mt-2 text-[11px] text-neutral-500">
                Mobile app can scan this payload as QR content. Desktop apps can paste pairing ID + code.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 p-5 mb-6">
        <h2 className="text-sm font-semibold text-neutral-900 mb-3">Redeem Pairing Code (App/Desktop)</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={redeemPairingId}
            onChange={(e) => setRedeemPairingId(e.target.value)}
            placeholder="Pairing ID"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          />
          <input
            value={redeemCode}
            onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
            placeholder="Pairing code"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          />
          <select
            value={redeemType}
            onChange={(e) => setRedeemType(e.target.value)}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          >
            <option value="mobile">Mobile</option>
            <option value="desktop">Desktop</option>
            <option value="web">Web</option>
            <option value="extension">Extension</option>
          </select>
          <input
            value={redeemName}
            onChange={(e) => setRedeemName(e.target.value)}
            placeholder="Device name"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          />
          <input
            value={redeemDeviceId}
            onChange={(e) => setRedeemDeviceId(e.target.value)}
            placeholder="Optional device_id"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          />
          <input
            value={redeemFcm}
            onChange={(e) => setRedeemFcm(e.target.value)}
            placeholder="Optional FCM token"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-maroon-100 focus:border-maroon-500"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            if (!redeemPairingId.trim() || !redeemCode.trim() || !redeemName.trim()) {
              setErrorMessage("Pairing ID, code, and device name are required.");
              return;
            }
            redeemMutation.mutate({
              pairing_id: redeemPairingId.trim(),
              code: redeemCode.trim(),
              device_type: redeemType,
              device_name: redeemName.trim(),
              device_id: redeemDeviceId.trim() || undefined,
              fcm_token: redeemFcm.trim() || undefined,
            });
          }}
          disabled={redeemMutation.isPending}
          className="mt-3 rounded-lg bg-maroon-500 text-white text-sm font-semibold px-4 py-2 hover:bg-maroon-600 disabled:opacity-50"
        >
          {redeemMutation.isPending ? "Linking..." : "Redeem & Link Device"}
        </button>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 divide-y divide-neutral-100">
        <div className="p-4 flex items-center justify-between">
          <div className="text-sm font-semibold text-neutral-900">Registered Devices</div>
          <button
            type="button"
            onClick={() => devicesQuery.refetch()}
            className="text-sm text-maroon-500 hover:underline"
          >
            Refresh
          </button>
        </div>

        {devicesQuery.isLoading && <div className="p-4 text-sm text-neutral-500">Loading devices...</div>}

        {!devicesQuery.isLoading && (devicesQuery.data ?? []).length === 0 && (
          <div className="p-4 text-sm text-neutral-400 text-center">
            No devices linked yet.
          </div>
        )}

        {(devicesQuery.data ?? []).map((device) => {
          const online = Boolean(device.connected ?? device.is_online);
          return (
            <div key={device.device_id} className="p-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-neutral-900">{device.device_name}</div>
                <div className="text-xs text-neutral-500 mt-1">
                  {device.device_type} · {online ? "Online" : "Offline"} · Last seen: {pretty(device.last_seen)}
                </div>
                <div className="text-[11px] text-neutral-400 mt-1 break-all">ID: {device.device_id}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${online ? "bg-green-500" : "bg-neutral-300"}`} />
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(`Remove device "${device.device_name}"?`)) return;
                    deleteMutation.mutate(device.device_id);
                  }}
                  className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
                >
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
