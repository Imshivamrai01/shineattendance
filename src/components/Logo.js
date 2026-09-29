/* Shine Infosolutions mark. The artwork is black/blue on white, so it always sits on a white tile. */
export default function Logo({ size = 32, className = '' }) {
  return (
    <span className={`logo-tile ${className}`} style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="Shine Infosolutions" width={size} height={size} />
    </span>
  );
}
