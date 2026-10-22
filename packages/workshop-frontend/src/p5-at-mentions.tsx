import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type { Options as MarkdownOptions } from 'react-markdown'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AiChatMessage, CollaboratorInfo, Overseer, SlashCommandRequest,
} from '@gadgets/workshop-shared/api'
import {
  atMentionGrants, atMentionSpans, atMentionToken, findAtMentions, otherPeopleInChat, type AtMentionCandidate,
} from '@gadgets/workshop-shared/p5-at-mentions'
import { useAuthenticatedApi } from './AuthContext'
import { useServerConfig } from './ServerConfigContext'
import { rpcFailureDescription } from './rpcErrors'
import { buildComposerSubmission } from './features/chat/composer/composerSubmission'
import type { ComposerDocument } from './features/chat/composer/composerDocument'
import { useUserDirectorySearch } from './features/user-directory/useUserDirectorySearch'
import { NoAgentLine, NotListedHint } from './p5-screen-fixes'

/** What the "@" list and the line under the composer say. */
export const AT_MENTION_WORDS = {
  peopleOnly: (names: string) =>
    `Goes to ${names} only. The agent won't answer this message; it will read it the next time someone asks it.`,
  agentWorking: 'The agent is working. Send this once it finishes.',
  willBeAdded: 'will be added as "Workspace": edit gadgets and use chat',
  willMove: 'will move to "Workspace": edit gadgets and use chat',
  notAdded: "Couldn't add them. Try again.",
}

type MentionRow = AtMentionCandidate & { joins?: string }

type PeopleInWorkspace = { inChat: AtMentionCandidate[]; useRole: AtMentionCandidate[]; isOwner: boolean }

type ListLayout = { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

const DISMISSING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown'])

const NAME_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

function listLayout(anchor: HTMLElement): ListLayout {
  const popup = { margin: 12, gap: 8, minHeight: 120, maxHeight: 440 }
  const rect = anchor.getBoundingClientRect()
  const width = Math.min(rect.width, window.innerWidth - popup.margin * 2)
  const left = Math.min(Math.max(rect.left, popup.margin), window.innerWidth - width - popup.margin)
  const spaceAbove = rect.top - popup.margin - popup.gap
  const spaceBelow = window.innerHeight - rect.bottom - popup.margin - popup.gap
  const openBelow = spaceBelow >= popup.minHeight || spaceBelow > spaceAbove
  const available = Math.max(openBelow ? spaceBelow : spaceAbove, popup.minHeight)
  return {
    left,
    width,
    maxHeight: Math.min(popup.maxHeight, available),
    ...(openBelow ? { top: rect.bottom + popup.gap } : { bottom: window.innerHeight - rect.top + popup.gap }),
  }
}

function mentionTokenAt(composerDocument: ComposerDocument, caret: number) {
  const token = atMentionToken(composerDocument.text, caret)
  const crossesItem = token !== null && [...composerDocument.capsules, ...composerDocument.formats]
    .some(range => range.start < caret && range.start + range.length > token.start)
  return crossesItem ? null : token
}

const matchesQuery = (person: AtMentionCandidate, query: string) =>
  person.name.toLowerCase().includes(query.toLowerCase()) || person.id.toLowerCase().includes(query.toLowerCase())

/**
 * The composer's "@" in a workspace: the list of people to name, the line under the composer, and
 * the check a send makes first. The owner's list also searches the user directory while `/admin`
 * user search is on, and the owner's send gives a picked person "Workspace" access before it goes.
 * While a turn runs, an "@" that names anyone is held back, since a send then steers that turn.
 * Inert off `/workspace/`: Home's `getOverseer` creates a workspace.
 */
export function useP5AtMentions({
  document: composerDocument, cursorPosition, noAgent, isAgentActive, getOverseer, anchorRef, textareaRef, editText,
  moveCaret, disabled,
}: {
  document: ComposerDocument
  cursorPosition: number
  noAgent: boolean
  isAgentActive: boolean
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>
  anchorRef: RefObject<HTMLElement | null>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  editText: (text: string, caret: number) => void
  moveCaret: (caret: number) => void
  disabled: boolean
}): {
  ui: ReactNode
  onKeyDown: (event: KeyboardEvent) => boolean
  beforeSend: (message: string | SlashCommandRequest) => Promise<boolean>
} {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const config = useServerConfig()
  const inWorkspace = window.location.pathname.startsWith('/workspace/')
  const offering = inWorkspace && composerDocument.command === null
  const text = composerDocument.text
  const token = offering && !disabled ? mentionTokenAt(composerDocument, cursorPosition) : null
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [people, setPeople] = useState<PeopleInWorkspace | null>(null)
  const [index, setIndex] = useState(0)
  const [picks, setPicks] = useState<AtMentionCandidate[]>([])
  const [refusal, setRefusal] = useState<{ text: string; draft: string } | null>(null)
  const [layout, setLayout] = useState<ListLayout | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  if (dismissedAt !== null && text[dismissedAt] !== '@') setDismissedAt(null)
  if (refusal && refusal.draft !== text) setRefusal(null)

  const wantsPeople = offering && text.includes('@')
  const tokenStart = token?.start ?? null
  useEffect(() => {
    if (!wantsPeople || !currentUser) return
    let cancelled = false
    void (async () => {
      const overseer = await getOverseer()
      const [metadata, collaborators] = await Promise.all([overseer.getMetadata(), overseer.listCollaborators()])
      if (cancelled) return
      const me = { id: currentUser.id, name: currentUser.name }
      setPeople({
        inChat: otherPeopleInChat(metadata.owner ?? me, collaborators, me.id),
        useRole: collaborators.filter(collaborator => collaborator.role === 'use').map(({ profile }) => profile),
        isOwner: !metadata.owner,
      })
    })().catch(error => console.error('Failed to load the people in this chat:', error))
    return () => {
      cancelled = true
    }
  }, [currentUser, getOverseer, tokenStart, wantsPeople])

  const open = token !== null && dismissedAt !== token.start
  const query = token?.query ?? ''
  const searching = open && people?.isOwner === true && config?.userSearchEnabled === true && query.trim() !== ''
  const excludeIds = useMemo(
    () => [...(currentUser ? [currentUser.id] : []), ...(people?.inChat ?? []).map(person => person.id)],
    [currentUser, people])
  const search = useCallback((value: string) => authenticatedApi.searchUsers(value, excludeIds),
    [authenticatedApi, excludeIds])
  const directory = useUserDirectorySearch({ query: searching ? query : '', enabled: searching, search })
  const found = searching && directory.current && directory.status === 'ready'

  const inChatRows: MentionRow[] = open && people ? people.inChat.filter(person => matchesQuery(person, query)) : []
  const searchRows: MentionRow[] = found && people
    ? directory.results.map(result => {
        const useRole = people.useRole.find(person => person.id === result.id)
        return useRole
          ? { ...useRole, joins: AT_MENTION_WORDS.willMove }
          : { id: result.id, name: result.name, joins: AT_MENTION_WORDS.willBeAdded }
      })
    : []
  const rows = [...inChatRows, ...searchRows]
  const notListed = found && directory.results.length === 0 && !query.includes(' ') && config?.signupsEnabled === true
  const shown = rows.length > 0 || notListed
  const activeIndex = rows.length === 0 ? -1 : Math.min(index, rows.length - 1)
  useEffect(() => setIndex(0), [query, tokenStart])

  useLayoutEffect(() => {
    if (!shown || !anchorRef.current) {
      setLayout(null)
      return
    }
    const update = () => {
      if (anchorRef.current) setLayout(listLayout(anchorRef.current))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, shown])

  useEffect(() => {
    if (tokenStart === null || !open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
      setDismissedAt(tokenStart)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, tokenStart])

  const pick = (row: MentionRow) => {
    if (!token) return
    const mention = `@${row.name}`
    const rest = text.slice(cursorPosition)
    const caret = token.start + mention.length + 1
    setDismissedAt(token.start)
    if (row.joins) setPicks(current => [...current.filter(person => person.id !== row.id), { id: row.id, name: row.name }])
    editText(text.slice(0, token.start) + mention + (rest.startsWith(' ') ? '' : ' ') + rest, caret)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      moveCaret(caret)
    })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!token || !open) return false
    if (activeIndex >= 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setIndex((activeIndex + direction + rows.length) % rows.length)
      return true
    }
    if (activeIndex >= 0 && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault()
      pick(rows[activeIndex]!)
      return true
    }
    if (event.key === 'Escape' && shown) {
      event.preventDefault()
      setDismissedAt(token.start)
      return true
    }
    if (DISMISSING_KEYS.has(event.key)) setDismissedAt(token.start)
    return false
  }

  const inChat = people?.inChat ?? []
  const submission = offering ? buildComposerSubmission({ document: composerDocument, hasAttachments: false }) : null
  const mentioned = submission?.ok && typeof submission.submission.message === 'string'
    ? findAtMentions(submission.submission.message, [...inChat, ...picks])
    : []

  const beforeSend = async (message: string | SlashCommandRequest) => {
    if (!inWorkspace || typeof message !== 'string') return true
    if (isAgentActive && findAtMentions(message, [...inChat, ...picks]).length > 0) return false
    const grants = atMentionGrants(message, inChat, picks)
    if (grants.length > 0) {
      const overseer = await getOverseer()
      for (const person of grants) {
        const refused = await overseer.addCollaborator(person.id, 'build').then(
          added => (added ? null : AT_MENTION_WORDS.notAdded),
          error => rpcFailureDescription(error) ?? AT_MENTION_WORDS.notAdded)
        if (refused !== null) {
          setRefusal({ text: `${person.name}: ${refused}`, draft: text })
          return false
        }
      }
    }
    setPicks([])
    return true
  }

  if (!inWorkspace) return { ui: null, onKeyDown, beforeSend }

  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined
  const list = shown && layout ? createPortal(
    <div
      ref={popupRef}
      className="themed-floating-shadow-lg fixed z-[1000] flex flex-col overflow-hidden rounded-2xl border border-kumo-line/70 bg-kumo-base"
      style={layout}
    >
      <div role="listbox" aria-label="People to mention" className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {rows.map((row, rowIndex) => (
          <button
            key={row.id}
            type="button"
            role="option"
            aria-selected={rowIndex === activeIndex}
            className={`flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${rowIndex === activeIndex ? 'bg-kumo-tint text-kumo-strong' : 'text-kumo-default hover:bg-kumo-tint/70'}`}
            onMouseMove={() => setIndex(rowIndex)}
            onClick={() => pick(row)}
          >
            <span className="w-full truncate text-[13px]">
              {row.name} <span className="text-kumo-subtle">· {row.id}</span>
            </span>
            {row.joins && <span className="w-full truncate text-[11.5px] text-kumo-inactive">{row.joins}</span>}
          </button>
        ))}
        {notListed && <div className="px-2 pb-1.5"><NotListedHint /></div>}
      </div>
    </div>,
    document.body,
  ) : null
  const hint = refusal
    ? <p role="alert" className="break-words px-4 pt-2 text-xs text-kumo-danger">{refusal.text}</p>
    : mentioned.length > 0
      ? (
          <p className="px-4 pt-2 text-xs text-kumo-subtle">
            {isAgentActive
              ? AT_MENTION_WORDS.agentWorking
              : AT_MENTION_WORDS.peopleOnly(NAME_LIST.format(mentioned.map(person => person.name)))}
          </p>
        )
      : <NoAgentLine noAgent={noAgent} agentActive={isAgentActive} />

  return {
    ui: (
      <>
        {list}
        <div className="sr-only" aria-live="polite">{activeRow ? activeRow.name : ''}</div>
        {hint}
      </>
    ),
    onKeyDown,
    beforeSend,
  }
}

export type { AtMentionCandidate }

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: object }

const NO_PEOPLE: readonly AtMentionCandidate[] = []

const MENTION_MARK = { hName: 'span', hProperties: { className: ['font-medium', 'text-kumo-brand'] } }

/**
 * The people each sender's "@" can name in this chat, as `otherPeopleInChat` reads them, by sender
 * id. Read from the workspace only once a person's message or queued steer holds an "@", and again
 * each time another one does.
 */
export function useP5AtMentionPeople(
  overseer: RpcStub<Overseer>, messages: readonly AiChatMessage[],
  queuedSteers?: readonly { text: string; author: AiChatAuthorInfo }[],
) {
  const { currentUser } = useAuthenticatedApi()
  const withAt = messages
    .filter(msg => msg.type === 'message' && msg.author.type === 'user' && msg.message.includes('@')).length +
    (queuedSteers ?? []).filter(steer => steer.text.includes('@')).length
  const [workspace, setWorkspace] =
    useState<{ owner: AtMentionCandidate; collaborators: CollaboratorInfo[] } | null>(null)
  useEffect(() => {
    if (withAt === 0) return
    let cancelled = false
    void (async () => {
      const [metadata, collaborators] = await Promise.all([overseer.getMetadata(), overseer.listCollaborators()])
      const owner = metadata.owner ?? currentUser
      if (!cancelled && owner) setWorkspace({ owner, collaborators })
    })().catch(error => console.error('Failed to load the people in this chat:', error))
    return () => {
      cancelled = true
    }
  }, [currentUser, withAt, overseer])
  return useMemo(() => {
    const bySender = new Map<string, readonly AtMentionCandidate[]>()
    return (senderId: string) => {
      if (!workspace) return NO_PEOPLE
      let people = bySender.get(senderId)
      if (!people) {
        people = otherPeopleInChat(workspace.owner, workspace.collaborators, senderId)
        bySender.set(senderId, people)
      }
      return people
    }
  }, [workspace])
}

function markAtMentions(node: MarkdownNode, people: readonly AtMentionCandidate[], read: readonly string[]) {
  if (!node.children) return
  node.children = node.children.flatMap(child => {
    if (child.type !== 'text' || !child.value) {
      markAtMentions(child, people, read)
      return [child]
    }
    const value = child.value
    const parts: MarkdownNode[] = []
    let cursor = 0
    for (const { start, end } of atMentionSpans(value, people)) {
      if (!read.includes(value.slice(start, end))) continue
      if (start > cursor) parts.push({ type: 'text', value: value.slice(cursor, start) })
      parts.push({ type: 'text', value: value.slice(start, end), data: MENTION_MARK })
      cursor = end
    }
    if (cursor === 0) return [child]
    if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) })
    return parts
  })
}

/**
 * `plugins` plus one that shows each "@" of `people` in `message` as a handle. A rendered span is
 * marked only when the raw message names it too.
 */
export function withP5AtMentions(
  plugins: NonNullable<MarkdownOptions['remarkPlugins']>, people: readonly AtMentionCandidate[] | undefined,
  message: string,
) {
  if (!people?.length) return plugins
  const read = atMentionSpans(message, people).map(({ start, end }) => message.slice(start, end))
  return [() => (tree: MarkdownNode) => markAtMentions(tree, people, read), ...plugins]
}
