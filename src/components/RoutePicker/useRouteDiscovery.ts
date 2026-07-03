import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cast, useCast } from 'react-native-queue-player';
import type { DiscoveryState, RouteInfo } from './types';

export interface UseRouteDiscoveryResult {
  /** All discovered receivers plus the local route, with isActive flags. */
  routes: RouteInfo[];
  /** Discovery scanning state for the sheet header spinner / banner. */
  state: DiscoveryState;
  /** True while at least one `connect()` is in flight. */
  isConnecting: boolean;
  /** Imperative `connect(receiverId)` with PIN/password retry support. */
  connect: (receiverId: string, password?: string) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Stops discovery (typically on sheet close). */
  stopDiscovery: () => Promise<void>;
}

/**
 * Wires RNQP's Cast discovery surface into a flat `RouteInfo[]` with isActive
 * markers + per-row connecting/error state. Starts discovery on mount and stops
 * it on unmount — so mounting this hook only while the picker sheet is open
 * keeps mDNS/multicast scanning scoped to when the user is looking.
 */
export function useRouteDiscovery(): UseRouteDiscoveryResult {
  const snapshot = useCast();
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  useEffect(() => {
    Cast.startDiscovery().catch(() => {});
    return () => {
      void Cast.stopDiscovery();
    };
  }, []);

  const state: DiscoveryState = useMemo(() => {
    if (snapshot.permission === 'denied') return 'permission-denied';
    if (!snapshot.isAvailable) return 'error';
    return snapshot.isDiscovering ? 'scanning' : 'idle';
  }, [snapshot.permission, snapshot.isAvailable, snapshot.isDiscovering]);

  const routes: RouteInfo[] = useMemo(() => {
    const localRoute: RouteInfo = {
      id: '',
      protocol: 'local',
      protocolVersion: '',
      name: snapshot.route.castProtocol === 'local' ? snapshot.route.name : 'This phone',
      modelName: '',
      iconHint: 'phone',
      capabilities: {
        supportsRemoteVolume: false,
        streamingModel: 'pushPcm',
        requiresPairing: false,
      },
      isActive: snapshot.route.castProtocol === 'local',
      isConnecting: false,
    };

    const remote: RouteInfo[] = snapshot.receivers.map((r) => ({
      id: r.id,
      protocol: r.castProtocol,
      protocolVersion: r.protocolVersion,
      name: r.name,
      modelName: r.modelName,
      iconHint: r.iconHint,
      capabilities: r.capabilities,
      isActive: snapshot.route.receiverId === r.id,
      isConnecting: connectingIds.has(r.id),
      lastError: errorById[r.id],
    }));

    return [localRoute, ...remote];
  }, [snapshot.receivers, snapshot.route, connectingIds, errorById]);

  const connect = useCallback(
    async (receiverId: string, password?: string) => {
      setConnectingIds((prev) => new Set(prev).add(receiverId));
      setErrorById((prev) => {
        const { [receiverId]: _drop, ...rest } = prev;
        return rest;
      });
      try {
        await Cast.connect(receiverId, password ? { password } : undefined);
      } catch (err) {
        const code =
          (err as { code?: string; name?: string })?.code ??
          (err as { name?: string })?.name ??
          'cast_connect_failed';
        setErrorById((prev) => ({ ...prev, [receiverId]: code }));
        throw err;
      } finally {
        setConnectingIds((prev) => {
          const next = new Set(prev);
          next.delete(receiverId);
          return next;
        });
      }
    },
    [],
  );

  const disconnect = useCallback(async () => {
    await Cast.disconnect();
  }, []);

  const stopDiscovery = useCallback(async () => {
    await Cast.stopDiscovery();
  }, []);

  return {
    routes,
    state,
    isConnecting: connectingIds.size > 0,
    connect,
    disconnect,
    stopDiscovery,
  };
}
