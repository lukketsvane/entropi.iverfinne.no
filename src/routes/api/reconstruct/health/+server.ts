import { reconstructionProxy } from '../../../../lib/server/reconstruction.mjs';
export const GET = () => reconstructionProxy().health();
