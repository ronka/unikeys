import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, letting a caller's utility beat the component's own.
 *
 * `clsx` flattens the conditional forms; `twMerge` then drops the earlier of any
 * two utilities that set the same CSS property, so `cn('px-2', 'px-4')` is
 * `px-4` rather than a coin toss on source order. Every generated shadcn
 * component routes its `className` prop through this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
