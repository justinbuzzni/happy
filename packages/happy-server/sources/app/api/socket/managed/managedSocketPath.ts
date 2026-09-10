/**
 * The managed socket endpoint.
 *
 * Its own path, distinct from `/v1/updates`, so the two engine.io instances on
 * one HTTP server never claim each other's upgrades. Like the legacy room
 * names, this string is a wire format: changing it disconnects live managed
 * children until they are told the new one.
 */
export const MANAGED_SOCKET_PATH = '/v1/managed-updates';
