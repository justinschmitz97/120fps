export interface CardProps {
  title: string;
}

export function Card({ title }: CardProps) {
  return (
    <div className="tw-card p-4">
      <span className="text-brand">{title}</span>
    </div>
  );
}
