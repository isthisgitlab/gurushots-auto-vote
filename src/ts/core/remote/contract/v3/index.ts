/**
 * Link version 3: the contract a phone page and a desktop that speak link version 3 hold each other to, whatever
 * app version either side runs. Type-only; nothing here exists at runtime. See `core/remote/protocol.ts`
 * (LINK_VERSION) for the rule, and `tests/remote/contractV3.test.ts` for the checks that keep the living types
 * inside it.
 */

import type { AppChannelsV3 } from './channelsApp';
import type { PhotosChannelsV3 } from './channelsPhotos';
import type { ScenarioLibraryChannelsV3 } from './channelsScenarioLibrary';
import type { ScenariosChannelsV3 } from './channelsScenarios';
import type { SettingsChannelsV3 } from './channelsSettings';
import type { VotingChannelsV3 } from './channelsVoting';

/** Every channel a desktop serves a phone (allowed or answered by the host): its arguments and its result. */
export type ChannelsV3 = AppChannelsV3 &
    PhotosChannelsV3 &
    ScenarioLibraryChannelsV3 &
    ScenariosChannelsV3 &
    SettingsChannelsV3 &
    VotingChannelsV3;

export type { EventPayloadsV3 } from './events';
export type {
    AutovoteCommandMessageV3,
    CommandAckV3,
    ControlReportV3,
    AutovoteStateMessageV3,
    ByeMessageV3,
    EventMessageV3,
    HelloMessageV3,
    InvokeMessageV3,
    PeerMessageV3,
    ResultMessageV3,
} from './envelope';
export type { SettingValuesV3 } from './settingValues';
export type { AutovoteStateV3 } from './shapesConfig';
