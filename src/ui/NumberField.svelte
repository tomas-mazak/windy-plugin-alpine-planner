<!-- An editable number: shows the formatted text, edits the plain number. Enter, the keyboard's action key and blur
     commit; Escape cancels. A form, so a mobile keyboard's action key submits instead of moving focus to the next
     field in the document (Windy's search, which closes us). While editing, its keys don't reach Windy's shortcuts
     ("-" would zoom out). -->
<form class="number-field" class:number-field--touch={ isMobileOrTablet } novalidate on:submit|preventDefault={ commit }>
    <input type="text" {inputmode} enterkeyhint="done" autocomplete="off" aria-label={ label } {title} {disabled}
        style="width: { isMobileOrTablet ? widths[1] : widths[0] }px" value={ editing ? draft : text } bind:this={ input }
        on:focus={ start } on:input={ e => (draft = e.currentTarget.value) } on:blur={ commit } />
</form>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';
    import { createEventDispatcher, onDestroy, tick } from 'svelte';

    import { parseNumber } from './parseNumber';

    export let text: string; // shown when not editing, e.g. "8,000+", "+200 m"
    export let value: number; // edited
    export let label: string;
    export let title: string | undefined = undefined;
    export let widths: [number, number]; // px: desktop, mobile
    export let inputmode: 'numeric' | 'text' = 'numeric'; // 'text' where a minus is needed (iOS's keypad has none)
    export let disabled = false;

    const dispatch = createEventDispatcher<{ commit: number }>();

    let editing = false;
    let draft = '';
    let input: HTMLInputElement;

    async function start(): Promise<void> {
        editing = true;
        guardKeys(true);
        draft = String(value);
        await tick();
        input.select();
    }

    // Idempotent: submit, Enter and blur all end up here.
    function commit(): void {
        if (!editing) {
            return;
        }
        editing = false; // first, so the blur() below can't commit again
        guardKeys(false);
        input.blur(); // closes the mobile keyboard
        const parsed = parseNumber(draft);
        if (parsed !== null) {
            dispatch('commit', parsed);
        }
    }

    // Windy's keyboard shortcuts act on the page's key events ("-" zooms out, "+" in, letters switch layers). While
    // editing, our input's key events stop at the window in the capture phase, before any of Windy's listeners, and
    // aren't cancelled, so the input still gets its characters and Enter still submits the form. Escape cancels here,
    // as the input's own listeners don't see the events either.
    const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

    function onKey(e: KeyboardEvent): void {
        if (e.target !== input) {
            return;
        }
        e.stopPropagation();
        if (e.type === 'keydown' && e.key === 'Escape') {
            editing = false;
            guardKeys(false);
            input.blur();
        }
    }

    function guardKeys(on: boolean): void {
        for (const type of KEY_EVENTS) {
            if (on) {
                window.addEventListener(type, onKey, true);
            } else {
                window.removeEventListener(type, onKey, true);
            }
        }
    }

    onDestroy(() => guardKeys(false));
</script>

<style lang="less">
    .number-field {
        display: flex;
        flex: 0 0 auto;
    }

    input {
        box-sizing: border-box;
        height: 22px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 3px;
        outline: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        text-align: center;

        &:hover {
            border-color: rgba(255, 255, 255, 0.5);
        }

        &:focus {
            border-color: #fff;
            background: rgba(255, 255, 255, 0.08);
        }

        &:disabled {
            border-color: rgba(255, 255, 255, 0.28);
        }

        .number-field--touch & {
            height: 34px;
            font-size: 14px;
        }
    }
</style>
