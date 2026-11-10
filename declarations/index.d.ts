// @windy/authParams is available to plugins at runtime, but @windycom/plugin-devtools ships no types for it.
declare module '@windy/authParams' {
    export const addTileAuthParams: (url: string) => string;
}
