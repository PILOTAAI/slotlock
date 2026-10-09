// OAuth discovery for the MCP endpoint: pass as `oauth` to createSlotlockAgentServer.
// #region oauth
import type { SlotlockAgentServerOAuthOptions } from 'slotlock';

export const oauth: SlotlockAgentServerOAuthOptions = {
  // Issuers whose access tokens your `authenticate` accepts (it must also check their audience),
  // written exactly as each server's metadata `issuer`: clients compare them as strings.
  authorizationServers: ['https://auth.example.com'],
  scopesSupported: ['calendar:read', 'calendar:write'],
  // Named in the 401 challenge so a client requests them up front.
  requiredScopes: ['calendar:read'],
};
// #endregion oauth
