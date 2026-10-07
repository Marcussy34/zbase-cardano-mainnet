import { useMDXComponents as getThemeComponents } from 'nextra-theme-docs';

// The docs theme brings the components that render headings, code and callouts.
const themeComponents = getThemeComponents();

export function useMDXComponents(components) {
  return { ...themeComponents, ...components };
}
