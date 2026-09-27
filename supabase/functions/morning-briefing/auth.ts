export type AccessKind = 'scheduler' | 'user' | 'unauthorized';

export function classifyRequest(options: {
  schedulerSecret: string;
  suppliedSchedulerSecret: string;
  hasAuthorization: boolean;
}): AccessKind {
  if (
    options.schedulerSecret.length > 0 &&
    options.suppliedSchedulerSecret === options.schedulerSecret
  ) {
    return 'scheduler';
  }
  return options.hasAuthorization ? 'user' : 'unauthorized';
}
