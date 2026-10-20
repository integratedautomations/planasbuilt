/** PlanAsBuilt lockup. `onChrome` = always on the navy header (dark lockup); otherwise follows color scheme. */
export function Brand({ onChrome = false }: { onChrome?: boolean }) {
  return (
    <>
      <picture className="brand-logo">
        {!onChrome && <source srcSet="/logo-dark.svg" media="(prefers-color-scheme: dark)" />}
        <img src={onChrome ? '/logo-dark.svg' : '/logo-light.svg'} alt="PlanAsBuilt" />
      </picture>
      <img className="brand-icon" src="/icon.svg" alt="PlanAsBuilt" />
    </>
  )
}
