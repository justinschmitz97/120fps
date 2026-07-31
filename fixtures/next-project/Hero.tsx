import Image from "next/image";
import Link from "next/link";

export interface HeroProps {
  title: string;
}

export function Hero({ title }: HeroProps) {
  return (
    <section>
      <Image src="/logo.png" alt="" width={32} height={32} />
      <Link href="/about">{title}</Link>
    </section>
  );
}
