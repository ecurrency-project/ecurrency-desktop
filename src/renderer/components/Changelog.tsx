import { useEffect, useId, useRef } from 'react'
import { brand } from '../brand'
import { CloseIcon } from '../ui'

function InlineText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part)}</>
}

const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

export function Changelog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current!
    if (open && !element.open) {
      element.showModal()
      if (history.current) history.current.scrollTop = 0
      heading.current?.focus()
    } else if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog ref={dialog} className="changelog-dialog" closedby="any" aria-labelledby={titleId}
      onClose={() => { if (!dialog.current?.open) onClose() }}>
      <header className="changelog-header">
        <div>
          <h1 ref={heading} id={titleId} tabIndex={-1}>What’s new</h1>
          <p>{brand.productName} <span aria-hidden="true">·</span> Installed version {__APP_VERSION__}</p>
        </div>
        <button type="button" className="modal-close" aria-label="Close changelog" onClick={() => dialog.current?.close()}>
          <CloseIcon size={18} />
        </button>
      </header>
      <div ref={history} className="changelog-body" tabIndex={0} role="region" aria-label="Release history">
        {__CHANGELOG__.length === 0 && <p>Release notes are not available for this build.</p>}
        {__CHANGELOG__.map((release) => (
          <article className="changelog-release" key={release.version} aria-label={`Version ${release.version}`}>
            <div className="changelog-version">
              <h2>{release.version}</h2>
              {release.version === __APP_VERSION__ && <span className="changelog-current">Installed</span>}
              <time dateTime={release.date}>{dateFormat.format(new Date(`${release.date}T00:00:00Z`))}</time>
            </div>
            {release.blocks.map((block, index) => {
              if (block.kind === 'heading') return <h3 key={index}>{block.text}</h3>
              if (block.kind === 'list') return <ul key={index}>{block.items.map((item, i) => <li key={i}><InlineText text={item} /></li>)}</ul>
              return <p key={index}><InlineText text={block.text} /></p>
            })}
          </article>
        ))}
      </div>
    </dialog>
  )
}
