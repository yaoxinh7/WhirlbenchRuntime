class WTimmer {
    constructor(){
        this._start=false;
        this._stop=true;
        this.startTime=0;
        this.stopTime=0;
    }


    set _started(value){
        this._start=!!value;
        this._stop=!this._start;
    }


    get time(){
        if (this._stop){
            return this.stopTime-this.startTime;
        }else{
            return Date.now()-this.startTime;
        }
    }


    start(){
        if (this._start) {
            console.warn('计时器已经开始了!');
            return;
        }
        if (this.startTime === 0){
            this.startTime=Date.now();
        }else{
            //注意时序 先取时间再设开始标记
            this.startTime=Date.now()-this.time;
        }
        this._started=true;
    }

    stop(){
        if (this._stop){
            console.warn('计时器没在走!');
            return;
        }
        this.stopTime=Date.now();
        this._started=false;
    }
    
    reset(){
        if (this._start){
            this.stop();
        }
        this.startTime=0;
        this.stopTime=0;
    }
}

export default WTimmer;