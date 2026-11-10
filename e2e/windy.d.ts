// What the tests read on Windy's page: the parts of the global W they use (the modules Windy exposes to plugins),
// the plugin's test API (src/lib/testApi.ts, mirrored here: the e2e project doesn't compile the plugin), and Windy's
// originals as the fixture saved them before the plugin opened.

type Calendar = { timestamps: number[]; premiumStart: number | null; start: number; end: number };

type Windy = {
    store: { get(key: string): any; set(key: string, value: unknown, options?: object): unknown };
    map: {
        map: {
            setView(center: [number, number], zoom: number): void;
            latLngToContainerPoint(latLng: [number, number]): { x: number; y: number };
            maplibreMap: { getLayer(id: string): unknown; getLayoutProperty(id: string, name: string): unknown };
        };
    };
    broadcast: { emit(topic: string, ...args: unknown[]): void };
    user: { isLoggedInPromise(): Promise<boolean> };
    subscription: { hasAny(): boolean };
    renderers: { tileLayer: { interpolator: unknown; userControl: unknown } };
    overlays: { temp: { createPickerHTML: unknown } };
    plugins: Record<string, { isOpen?: boolean } | undefined>;
    products: Record<string, { getCalendar(): Promise<Calendar> } | undefined>;
};

type IsoWindow = { start: number; end: number; clipped: boolean };

type TestApi = {
    version: string;
    state(): {
        tool: 'temp' | 'mask';
        temp: { mode: 'instant' | 'min' | 'max'; correction: boolean };
        mask: {
            mode: 'off' | 'elevation' | 'freezing';
            isoMode: 'instant' | 'min' | 'max' | 'both';
            isoCorrection: boolean;
            window: IsoWindow | null;
        };
        values: { from: number; to: number; offset: number };
    };
    status(): {
        temp: string[];
        mask: string[];
        loading: { temp: boolean; mask: boolean };
        failed: { temp: number; mask: number };
    };
    hooks(): {
        interpolator: boolean;
        picker: boolean;
        rangeControl: boolean;
        windyLayerHidden: boolean;
        windyLayerId: string | null;
        userControl: string | null;
        interpolatorIsWindys: boolean;
    };
    boxSize(): { width: number; height: number };
};

type WindyOriginals = { interpolator: unknown; createPickerHTML: unknown; userControl: string };

interface Window {
    W: Windy;
    __alpinePlanner?: TestApi;
    __e2eWindy?: WindyOriginals;
}
