export {
  DEFAULT_PLATE_NAME,
  MAX_PLATES,
  PLATE_GAP_MM,
  type Plate,
  type PlateBuildVolume,
  type PlateOffsetMm,
} from './types';
export {
  createPlate,
  defaultPlateName,
  derivePlateOffset,
  lowestFreeSlotIndex,
  plateOffsetsEqual,
  resolveModelPlateId,
  platesNeedRepack,
} from './plateLayout';
