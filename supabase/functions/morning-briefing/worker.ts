export type DeliveryClaim = {
  id: string;
  owner_id: string;
  lease_until: string;
  payload?: unknown;
};

export type DeliveryResult = {
  skipped: boolean;
  providerId?: string;
};

type Dependencies = {
  sendForUser: (
    ownerId: string,
    idempotencyKey: string,
    claim: DeliveryClaim
  ) => Promise<DeliveryResult>;
  finishDelivery: (
    claim: DeliveryClaim,
    state: 'sent' | 'skipped' | 'failed',
    providerId: string | null,
    error: string | null,
    retryAfterSeconds: number
  ) => Promise<void>;
  safeError: (error: unknown) => string;
};

export async function processDeliveryClaims(claims: DeliveryClaim[], dependencies: Dependencies) {
  for (const claim of claims) {
    try {
      const result = await dependencies.sendForUser(claim.owner_id, claim.id, claim);
      await dependencies.finishDelivery(
        claim,
        result.skipped ? 'skipped' : 'sent',
        result.providerId || null,
        null,
        0
      );
    } catch (error) {
      const retryAfterSeconds =
        typeof error === 'object' &&
        error &&
        'retryAfterSeconds' in error &&
        typeof error.retryAfterSeconds === 'number'
          ? error.retryAfterSeconds
          : 0;
      try {
        await dependencies.finishDelivery(
          claim,
          'failed',
          null,
          dependencies.safeError(error),
          retryAfterSeconds
        );
      } catch (_finishError) {
        // A lease guard in the database prevents a late worker from changing
        // a claim that has already been recovered by another worker.
      }
    }
  }
}
