import React from "react";

// heroui's shape: several exported components in one file, the canonical one
// declared last, each with its own props interface.
interface BadgeAnchorProps {
  className?: string;
  children: React.ReactNode;
}

const BadgeAnchor = ({ children, className }: BadgeAnchorProps) =>
  React.createElement("span", { className }, children);

interface BadgeLabelProps {
  className?: string;
}

const BadgeLabel = ({ className }: BadgeLabelProps) =>
  React.createElement("span", { className });

interface BadgeRootProps {
  children?: React.ReactNode;
  className?: string;
  color?: "accent" | "danger" | "default" | "success" | "warning";
  placement?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  size?: "sm" | "md" | "lg";
  variant?: "primary" | "secondary";
}

const BadgeRoot = ({ children, className, color, placement, size, variant }: BadgeRootProps) =>
  React.createElement("span", { className, "data-color": color, "data-placement": placement, "data-size": size, "data-variant": variant }, children);

export { BadgeRoot, BadgeLabel, BadgeAnchor };
