import { getToken } from '../vault.ts';
import { markSource } from './scheduler.ts';

export async function collectContextForUser(userId: string): Promise<void> {
  const cred = await getToken(userId, 'slack', 'default');
  if (!cred) {
    await markSource(userId, 'context-indexer', false, 'no slack token configured');
    return;
  }

  // Stub: the real implementation will use the Slack token to fetch recent
  // messages from the user's configured channels, chunk them, and store them
  // as context_snippets rows for retrieval during fact-checking.
  await markSource(userId, 'context-indexer', true);
}
