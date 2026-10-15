export function resolutionWeight(value: unknown): number
export function selectAutomaticRelease<T extends { release_ref: string; resolution?: string }>(results: T[], ceiling?: string): T | null
