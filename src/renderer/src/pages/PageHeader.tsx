/**
 * The title row every page that is not the table shares.
 *
 * The table has no header of its own — its controls sit where a title would, and
 * a heading above a full-height grid would only cost it rows.
 */
export function PageHeader({
  title,
  description,
  actions
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-start gap-4 px-6 pt-2 pb-5">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
