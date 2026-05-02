import React from "react";

interface HeaderProps {
  title: string;
  sticky?: boolean;
}

interface FooterProps {
  copyright: string;
  year?: number;
}

export function Header({ title, sticky = false }: HeaderProps) {
  return <header className={sticky ? "sticky" : ""}><h1>{title}</h1></header>;
}

export function Footer({ copyright, year = 2026 }: FooterProps) {
  return <footer>© {year} {copyright}</footer>;
}
