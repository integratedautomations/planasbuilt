import { useSyncExternalStore } from 'react'
import { getPeers, getStatus, subscribePeers, subscribeStatus } from './socket'

export const useSocketStatus = () => useSyncExternalStore(subscribeStatus, getStatus, getStatus)
/** Other people in the current document (this tab excluded). */
export const usePeers = () => useSyncExternalStore(subscribePeers, getPeers, getPeers)
