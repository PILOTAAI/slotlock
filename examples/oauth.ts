// OAuth discovery for the MCP endpoint: pass as `oauth` to createSlotlockAgentServer.
// #region oauth
import type { SlotlockAgentServerOAuthOptions } from 'slotlock';

export const oauth: SlotlockAgentServerOAuthOptions = {
  authorizationServers: ['https://auth.example.com'],
  scopesSupported: ['calendar:read', 'calendar:write'],
  requiredScopes: ['calendar:read'],
};
// #endregion oauth
