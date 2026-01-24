//% block="Rib:Bit Storage"
//% color="#c47122"
//% icon="\u26A0"
//% groups=[ "Files", "Data" ]
namespace RibBitSD {
    //% block="switch microSD card $state \u26A0"
    export function switchSD(state: RibBit.OnOff = RibBit.OnOff.On): void {
        return
    }

    //% block="create a new log called $name \u26A0"
    //% group="Files"
    export function setLogName(name: string = "newlog"): void {
        return;
    }

    //% block="uSD card present \u26A0"
    //% advanced="true"
    export function isSDPresent(): boolean {
        return false;
    }

    //% block="log data $data \u26A0"
    //% group="Data"
    export function logData(data: any): void {
        return;
    }
}