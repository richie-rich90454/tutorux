type ClassMap = Readonly<Record<string, string>>;

function utilityTokens(value: string | undefined): string[] {
    return value?.split(/\s+/u).filter(Boolean) ?? [];
}

/**
 * Combines semantic state classes with Tailwind utilities generated for this TSX module.
 * Class-list utilities stay guarded by their semantic class so toggled states remain exact.
 */
export function twClasses(
    value: string | false | null | undefined,
    styles: ClassMap,
    tagName?: string,
    conditionalClasses: readonly string[] = [],
): string {
    const classNames = utilityTokens(typeof value === "string" ? value : undefined);
    const utilities = classNames.flatMap((className) => utilityTokens(styles[className]));
    utilities.push(
        ...conditionalClasses.flatMap((className) => utilityTokens(styles[`?${className}`])),
    );
    if (tagName) utilities.push(...utilityTokens(styles[`@${tagName}`]));

    return [...new Set([...classNames, ...utilities])].join(" ");
}

/** Resolves selector-guarded Tailwind utilities for imperative classList additions. */
export function twUtilities(styles: ClassMap, classNames: readonly string[]): string[] {
    return [...new Set(classNames.flatMap((className) => utilityTokens(styles[`?${className}`])))];
}
