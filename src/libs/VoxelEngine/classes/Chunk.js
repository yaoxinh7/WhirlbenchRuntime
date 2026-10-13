import { rotationTyped } from "./def/rotationTyped";

class Chunk{
    constructor(chunkBuffer,compressed){
        if (!chunkBuffer instanceof ArrayBuffer) {
            throw new TypeError('chunkBuffer 必须是ArrayBuffer!');
        }
        //0~8191 ids
        this.blockIds=new Uint16Array(chunkBuffer,0,4096);
        //8192~12287 rotations
        this.blockRots=new Uint8Array(chunkBuffer,8192,4096);
        //12288~16384 infos
        this.blockInfos=new Uint8Array(chunkBuffer,12288,4096);
    }
}