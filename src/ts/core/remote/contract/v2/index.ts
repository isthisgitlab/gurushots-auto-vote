/**
 * Link version 2: the contract a phone page and a desktop that speak link version 2 hold each other to, whatever
 * app version either side runs. Type-only; nothing here exists at runtime. See `core/remote/protocol.ts`
 * (LINK_VERSION) for the rule, and `tests/remote/contractV2.test.ts` for the checks that keep the living types
 * inside it.
 */

import type { AppChannelsV2 } from './channelsApp';
import type { PhotosChannelsV2 } from './channelsPhotos';
import type { ScenarioLibraryChannelsV2 } from './channelsScenarioLibrary';
import type { ScenariosChannelsV2 } from './channelsScenarios';
import type { SettingsChannelsV2 } from './channelsSettings';
import type { VotingChannelsV2 } from './channelsVoting';

/** Every channel a desktop serves a phone (allowed or answered by the host): its arguments and its result. */
export type ChannelsV2 = AppChannelsV2 &
    PhotosChannelsV2 &
    ScenarioLibraryChannelsV2 &
    ScenariosChannelsV2 &
    SettingsChannelsV2 &
    VotingChannelsV2;

export type { EventPayloadsV2 } from './events';
export type {
    AutovoteCommandMessageV2,
    AutovoteStateMessageV2,
    ByeMessageV2,
    EventMessageV2,
    HelloMessageV2,
    InvokeMessageV2,
    PeerMessageV2,
    ResultMessageV2,
} from './envelope';
export type { SettingValuesV2 } from './settingValues';
export type { AutovoteStateV2 } from './shapesConfig';
