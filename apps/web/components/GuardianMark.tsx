/** Original geometric mark for the concept: a seal with two interlocking arcs (caller ↔ customer). Not an RBC asset. */
export function GuardianMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <circle cx="16" cy="16" r="14.5" fill="#0f2750" stroke="#e0b660" strokeWidth="1.5" />
      <path d="M9 17.5a7 7 0 0 1 11.5-6.2" fill="none" stroke="#e0b660" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M23 14.5a7 7 0 0 1-11.5 6.2" fill="none" stroke="#4c8dff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2" fill="#eaf0f9" />
    </svg>
  );
}
