const modulename = 'SocketRoom:Status';
import { RoomType } from "../webSocket";
import consoleFactory from '@lib/console';
import { DashboardDataEventType } from "@shared/socketioTypes";
const console = consoleFactory(modulename);


/**
 * Returns the dashboard stats data
 */
const getInitialData = (): DashboardDataEventType => {
    const svRuntimeStats = txCore.statsManager.svRuntime.getRecentStats();

    return {
        // joinLeaveTally30m: txCore.playerlistManager.joinLeaveTally,
        playerDrop: {
            summaryLast6h: txCore.statsManager.playerDrop.getRecentDropTally(6),
        },
        svRuntime: {
            fxsMemory: svRuntimeStats.fxsMemory,
            nodeMemory: svRuntimeStats.nodeMemory,
            perfBoundaries: svRuntimeStats.perfBoundaries,
            perfBucketCounts: svRuntimeStats.perfBucketCounts,
        },
    }
}


/**
 * The room for the dashboard page.
 * It relays server performance stuff and drop reason categories.
 * 
 * NOTE: 
 * - active push event for only from StatsManager.svRuntime
 * - StatsManager.playerDrop does not push events, those are sent alongside the playerlist drop event
 *   which means that if accessing from NUI (ie not joining playerlist room), the chart will only be
 *   updated when the user refreshes the page.
 *   Same goes for "last 6h" not expiring old data if the server is not online pushing new perfs.
 */
export default {
    permission: true, //everyone can see it
    eventName: 'dashboard',
    cumulativeBuffer: false,
    outBuffer: null,
    initialData: () => {
        return getInitialData();
    },
} satisfies RoomType;
