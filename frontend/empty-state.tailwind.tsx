export const emptyStateTailwindStyles = {
    "empty-state": `[align-items:flex-start] [background:transparent] [border-radius:5px] [border-top:1px_solid_var(--line-soft)] [display:flex] [flex-direction:column] [justify-content:flex-start] [min-height:180px] [padding:36px_2px_42px] [text-align:left]`,
    "empty-illustration": `[display:none]`,
    "@h2": `[.empty-state_&]:[color:var(--ink)] [.empty-state_&]:[font-size:18px] [.empty-state_&]:[font-weight:600] [.empty-state_&]:[letter-spacing:-0.02em] [.empty-state_&]:[margin:0]`,
    "@p": `[.empty-state_&]:[color:var(--muted)] [.empty-state_&]:[font-size:14px] [.empty-state_&]:[line-height:1.6] [.empty-state_&]:[margin:7px_0_18px] [.empty-state_&]:[max-width:58ch]`,
} as const;
