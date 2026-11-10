// Windy's time format, shared by the forecast layer and the isotherm mask.

import * as format from '@windy/format';
import store from '@windy/store';
import { t } from '@windy/trans';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

// Windy's time label: short weekday and time in the user's 12/24 h format (as the timeline), plus UTC in zulu mode.
export function formatWindyTime(ts: number): string {
    const day = t[`${WEEKDAYS[new Date(ts).getDay()]}2`];
    const utc = store.get('zuluMode') ? ` (${format.hourMinuteUTC(ts)})` : '';
    return `${day} ${format.tsToFormattedTime(ts)}${utc}`;
}
