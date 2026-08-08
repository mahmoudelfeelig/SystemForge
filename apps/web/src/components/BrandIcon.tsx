interface BrandIconProps {
  className?: string;
}

export function BrandIcon({ className = "" }: BrandIconProps) {
  return (
    <span className={`brand-icon ${className}`.trim()} aria-hidden="true">
      <img src="/assets/mahmoud-elephant.png" alt="" />
    </span>
  );
}
