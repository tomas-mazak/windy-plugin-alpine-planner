import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-alpine-planner',
    version: '1.0.0',
    icon: '⛰️',
    title: 'Alpine planner',
    description:
        'Planning tools for the mountains: temperature minimum/maximum over a period and at real terrain height, and terrain masks by elevation or freezing level.',
    author: 'Tomas Mazak',
    repository: 'https://github.com/tomas-mazak/windy-plugin-alpine-planner',
    desktopUI: 'embedded',
    mobileUI: 'small',
    private: false,
};

export default config;
