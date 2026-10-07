export default function Mark({ size = 32, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" {...props}>
      <path d="M6 7h21l-6 6H5V8a1 1 0 0 1 1-1Zm5 12h16v5a1 1 0 0 1-1 1H5Z" fill="currentColor" />
      <path d="m19 13-6 6H5l6-6Z" fill="currentColor" opacity=".45" />
    </svg>
  );
}
