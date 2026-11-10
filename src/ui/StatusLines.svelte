<!-- A tool's status: one line each, cut with an ellipsis (the full text in the tooltip). Info lines are secondary;
     an error is in the primary text colour. -->
{#each lines as line}
    <div class="status-line" class:status-line--error={ line.error } class:status-line--touch={ isMobileOrTablet }
        title={ line.title ?? line.text }>{ line.text }</div>
{/each}

<script lang="ts" context="module">
    export type StatusLine = { text: string; title?: string; error?: boolean };
</script>

<script lang="ts">
    import { isMobileOrTablet } from '@windy/rootScope';

    export let lines: StatusLine[];
</script>

<style lang="less">
    .status-line {
        margin-top: 4px;
        overflow: hidden;
        color: #a9adb3; // Windy's --color-text-secondary is a light yellow in dark content
        font-size: 11px;
        line-height: 13px;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .status-line--touch {
        font-size: 12px;
        line-height: 15px;
    }

    .status-line--error {
        color: var(--color-text-primary);
    }
</style>
