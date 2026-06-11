import { getInstanceUrl } from '../services/salesforce.js';

export async function instanceUrl({ sendJson, res }) {
  try {
    const url = await getInstanceUrl();
    sendJson(res, 200, { instanceUrl: url });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}
