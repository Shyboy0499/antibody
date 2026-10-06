// Ported from dsh-errkb, src/inject.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE): the injector, which joins the notice text and caps
// (src/notice.ts) with fix trust (src/trust.ts). T13 and T14 refer to
// dsh-errkb's task list.
import type { Hit } from "./match";
import { CapTracker, hardClip, noticeText, oneLine } from "./notice";
import type { InjectMode, Notice, NoticeEvent, NoticeKind } from "./notice";
import { askFixText } from "./resolve-detect";
import { FixTrust } from "./trust";

/** Everything an injector needs; all of it is per session except trust. */
export interface InjectorDeps {
  mode?: InjectMode;
  caps?: CapTracker;
  trust?: FixTrust;
  /** The session, which scopes fix-trust recurrence when trust is shared. */
  scope?: string;
}

/**
 * Decides, per session, which captured errors become notices: the `inject`
 * setting, non-injectable entries, fix trust and the caps, in that order.
 */
export class Injector {
  readonly mode: InjectMode;
  readonly caps: CapTracker;
  readonly trust: FixTrust;
  readonly scope: string;

  constructor(deps: InjectorDeps = {}) {
    this.mode = deps.mode ?? "hit-only";
    this.caps = deps.caps ?? new CapTracker();
    this.trust = deps.trust ?? new FixTrust();
    this.scope = deps.scope ?? "";
  }

  beginTurn(): void {
    this.caps.beginTurn();
    this.trust.beginTurn(this.scope);
  }

  beginStep(): void {
    this.caps.beginStep();
  }

  /**
   * Tell fix trust that a captured error matched `hit`, without offering a
   * notice yet. For a notice that rides a later step (T13: a dead turn's
   * error): the capture is observed when it happens, the notice offered when
   * the next step opens, with `observed` set.
   */
  observe(hit: Hit): void {
    this.trust.seen(hit.id, hit.entry.fix, this.scope);
  }

  /**
   * Offer a captured error.
   *
   * @param event - the hit or the miss.
   * @param observed - observe() already saw this hit; do not count it again.
   * @param promised - the session was told this entry's fix would be passed
   *   on (a claim hint): a fix is not held back by the turn's budget.
   * @returns the notice to inject, or undefined to stay silent.
   */
  offer(
    event: NoticeEvent,
    observed = false,
    promised = false,
  ): Notice | undefined {
    if (this.mode === "off") return undefined;
    if (event.kind === "miss") {
      if (this.mode !== "always" || !this.caps.tryEmit(event.id))
        return undefined;
      return notice(event.id, noticeText(event));
    }

    const { id, entry, injectable } = event.hit;
    if (!observed) this.observe(event.hit);
    if (!injectable) return undefined;
    const carriesFix = oneLine(entry.fix) !== "";
    const level = carriesFix ? this.trust.level(id, entry.fix) : "trusted";
    if (level === "suppressed") return undefined;
    if (
      !this.caps.tryEmit(id, entry.status === "fixed", promised && carriesFix)
    )
      return undefined;
    if (carriesFix) this.trust.injected(id, entry.fix, this.scope);
    return notice(id, noticeText(event, level));
  }

  /**
   * Offer the one-shot fix prompt for `id`, which looks resolved (T14). It
   * spends the step and turn budgets like any notice. Its per-ID budget is
   * its own, not the entry's: the prompt is a different message, asked once
   * by construction, and an entry whose "no fix recorded yet" notices used up
   * its two would otherwise never be asked.
   *
   * @returns the notice, or undefined when `inject` is off or a cap refuses.
   */
  ask(id: string): Notice | undefined {
    if (this.mode === "off" || !this.caps.tryEmit(`${id}\0ask`))
      return undefined;
    return notice(id, { kind: "ask-fix", text: hardClip(askFixText(id)) });
  }
}

function notice(
  id: string,
  { kind, text }: { kind: NoticeKind; text: string },
): Notice {
  return { id, kind, text };
}
