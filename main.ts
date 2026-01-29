//% color="#303030" weight=100 icon="\uf7c2" block="SD Card"
namespace SDCard {

    export enum Command {
        CMD0_GO_IDLE_STATE = 0,
        CMD1_SEND_OP_COND = 1,
        CMD8_SEND_IF_COND = 8,
        CMD9_SEND_CSD = 9,
        CMD10_SEND_CID = 10,
        CMD12_STOP_TRANSMISSION = 12,
        CMD13_SEND_STATUS = 13,
        CMD16_SET_BLOCKLEN = 16,
        CMD17_READ_SINGLE_BLOCK = 17,
        CMD18_READ_MULTIPLE_BLOCK = 18,
        CMD24_WRITE_BLOCK = 24,
        CMD25_WRITE_MULTIPLE_BLOCK = 25,
        CMD55_APP_CMD = 55,
        CMD58_READ_OCR = 58,
        ACMD41_SD_SEND_OP_COND = 41
    }

    export enum R1Response {
        IDLE_STATE = 0x01,
        ERASE_RESET = 0x02,
        ILLEGAL_COMMAND = 0x04,
        CRC_ERROR = 0x08,
        ERASE_SEQ_ERROR = 0x10,
        ADDRESS_ERROR = 0x20,
        PARAMETER_ERROR = 0x40,
        VALID_RESPONSE = 0x00
    }

    export enum DataResponse {
        DATA_ACCEPTED = 0x05,
        DATA_CRC_ERROR = 0x0B,
        DATA_WRITE_ERROR = 0x0D
    }

    export enum DataToken {
        START_BLOCK = 0xFE,
        START_BLOCK_MULTI = 0xFC,
        STOP_TRAN = 0xFD
    }

    export enum CardType {
        UNKNOWN = 0,
        SD_V1 = 1,
        SD_V2_SC = 2,
        SD_V2_HC = 3
    }

    export enum ErrorCode {
        OK = 0,
        TIMEOUT = 1,
        CRC_ERROR = 2,
        WRITE_ERROR = 3,
        INIT_FAILED = 4,
        NOT_INITIALIZED = 5,
        INVALID_PARAM = 6,
        FILE_NOT_FOUND = 7,
        NO_FILE_OPEN = 8,
        DISK_FULL = 9,
        INVALID_FS = 10,
        END_OF_FILE = 11
    }

    export enum FSType {
        UNKNOWN = 0,
        FAT16 = 1,
        FAT32 = 2
    }

    export enum FileMode {
        //% block="read"
        READ = 0,
        //% block="write"
        WRITE = 1,
        //% block="append"
        APPEND = 2
    }

    // State variables
    let _initialized = false
    let _cardType = CardType.UNKNOWN
    let _fsType = FSType.UNKNOWN
    let _sectorsPerCluster = 0
    let _reservedSectors = 0
    let _numberOfFATs = 0
    let _rootEntryCount = 0
    let _sectorsPerFAT = 0
    let _rootCluster = 0
    let _fatStartSector = 0
    let _rootDirStartSector = 0
    let _dataStartSector = 0
    let _partitionStart = 0

    let _fileOpen = false
    let _fileMode = FileMode.READ
    let _fileStartCluster = 0
    let _fileSize = 0
    let _filePosition = 0
    let _fileDirEntrySector = 0
    let _fileDirEntryOffset = 0
    let _currentCluster = 0
    let _clusterOffset = 0

    let _sectorBuffer: Buffer = null
    let _bufferDirty = false
    let _bufferedSector = -1

    let _foundSector = 0
    let _foundOffset = 0
    let _foundCluster = 0
    let _foundSize = 0

    // ========== LOW-LEVEL SPI FUNCTIONS ==========

    export function select(): void {
        RibBit.ribbit_cmd(RibBit.Device.SD, RibBit.Command.SPI_SELECT)
    }

    export function deselect(): void {
        RibBit.ribbit_cmd(RibBit.Device.INVALID, RibBit.Command.SPI_SELECT)
        pins.spiWrite(0xFF)
    }

    export function waitReady(timeout: number = 500): boolean {
        let startTime = input.runningTime()
        while (input.runningTime() - startTime < timeout) {
            if (pins.spiWrite(0xFF) === 0xFF) {
                return true
            }
            basic.pause(1)
        }
        return false
    }

    export function sendCommand(cmd: Command, arg: number): number {
        waitReady(100)
        let cmdByte = 0x40 | (cmd & 0x3F)
        pins.spiWrite(cmdByte)
        pins.spiWrite((arg >> 24) & 0xFF)
        pins.spiWrite((arg >> 16) & 0xFF)
        pins.spiWrite((arg >> 8) & 0xFF)
        pins.spiWrite(arg & 0xFF)
        let crc = 0xFF
        if (cmd === Command.CMD0_GO_IDLE_STATE) {
            crc = 0x95
        } else if (cmd === Command.CMD8_SEND_IF_COND) {
            crc = 0x87
        }
        pins.spiWrite(crc)
        let response = 0xFF
        for (let i = 0; i < 10; i++) {
            response = pins.spiWrite(0xFF)
            if ((response & 0x80) === 0) {
                break
            }
        }
        return response
    }

    export function sendAppCommand(cmd: Command, arg: number): number {
        sendCommand(Command.CMD55_APP_CMD, 0)
        return sendCommand(cmd, arg)
    }

    function readR7Response(): number {
        let result = 0
        for (let i = 0; i < 4; i++) {
            result = (result << 8) | pins.spiWrite(0xFF)
        }
        return result
    }

    function readOCR(): number {
        let result = 0
        for (let i = 0; i < 4; i++) {
            result = (result << 8) | pins.spiWrite(0xFF)
        }
        return result
    }

    function waitDataToken(timeout: number = 200): number {
        let startTime = input.runningTime()
        let token = 0xFF
        while (input.runningTime() - startTime < timeout) {
            token = pins.spiWrite(0xFF)
            if (token !== 0xFF) {
                return token
            }
        }
        return 0xFF
    }

    // ========== HELPER FUNCTIONS ==========

    function readUInt16LE(buf: Buffer, offset: number): number {
        return buf[offset] | (buf[offset + 1] << 8)
    }

    function readUInt32LE(buf: Buffer, offset: number): number {
        return buf[offset] | (buf[offset + 1] << 8) |
            (buf[offset + 2] << 16) | (buf[offset + 3] << 24)
    }

    function writeUInt16LE(buf: Buffer, offset: number, value: number): void {
        buf[offset] = value & 0xFF
        buf[offset + 1] = (value >> 8) & 0xFF
    }

    function writeUInt32LE(buf: Buffer, offset: number, value: number): void {
        buf[offset] = value & 0xFF
        buf[offset + 1] = (value >> 8) & 0xFF
        buf[offset + 2] = (value >> 16) & 0xFF
        buf[offset + 3] = (value >> 24) & 0xFF
    }

    // ========== BUFFERED SECTOR ACCESS ==========

    function flushBuffer(): ErrorCode {
        if (!_bufferDirty || _bufferedSector < 0 || _sectorBuffer == null) {
            return ErrorCode.OK
        }
        let result = writeSector(_bufferedSector, _sectorBuffer)
        if (result === ErrorCode.OK) {
            _bufferDirty = false
        }
        return result
    }

    function readSectorInto(sector: number, buffer: Buffer): boolean {
        let addr = (_cardType === CardType.SD_V2_HC) ? sector : sector * 512
        select()
        let r1 = sendCommand(Command.CMD17_READ_SINGLE_BLOCK, addr)
        if (r1 !== R1Response.VALID_RESPONSE) {
            deselect()
            return false
        }
        let token = waitDataToken()
        if (token !== DataToken.START_BLOCK) {
            deselect()
            return false
        }
        for (let i = 0; i < 512; i++) {
            buffer[i] = pins.spiWrite(0xFF)
        }
        pins.spiWrite(0xFF)
        pins.spiWrite(0xFF)
        deselect()
        return true
    }

    function loadSector(sector: number): ErrorCode {
        if (_bufferedSector === sector && _sectorBuffer != null) {
            return ErrorCode.OK
        }
        let result = flushBuffer()
        if (result !== ErrorCode.OK) {
            return result
        }
        if (_sectorBuffer == null) {
            _sectorBuffer = pins.createBuffer(512)
        }
        if (!readSectorInto(sector, _sectorBuffer)) {
            _bufferedSector = -1
            return ErrorCode.TIMEOUT
        }
        _bufferedSector = sector
        _bufferDirty = false
        return ErrorCode.OK
    }

    function writeSector(sector: number, data: Buffer): ErrorCode {
        if (data == null || data.length !== 512) {
            return ErrorCode.INVALID_PARAM
        }
        let addr = (_cardType === CardType.SD_V2_HC) ? sector : sector * 512
        select()
        if (!waitReady(500)) {
            deselect()
            return ErrorCode.TIMEOUT
        }
        let r1 = sendCommand(Command.CMD24_WRITE_BLOCK, addr)
        if (r1 !== R1Response.VALID_RESPONSE) {
            deselect()
            return ErrorCode.WRITE_ERROR
        }
        pins.spiWrite(DataToken.START_BLOCK)
        for (let i = 0; i < 512; i++) {
            pins.spiWrite(data[i])
        }
        pins.spiWrite(0xFF)
        pins.spiWrite(0xFF)
        let response = pins.spiWrite(0xFF) & 0x1F
        if (response !== DataResponse.DATA_ACCEPTED) {
            deselect()
            if (response === DataResponse.DATA_CRC_ERROR) {
                return ErrorCode.CRC_ERROR
            }
            return ErrorCode.WRITE_ERROR
        }
        if (!waitReady(500)) {
            deselect()
            return ErrorCode.TIMEOUT
        }
        deselect()
        return ErrorCode.OK
    }

    // ========== INITIALIZATION ==========

    export function initializeCard(): boolean {
        _initialized = false
        _cardType = CardType.UNKNOWN
        _fsType = FSType.UNKNOWN
        pins.spiFormat(8, 0)
        pins.spiFrequency(250000)
        deselect()
        for (let i = 0; i < 10; i++) {
            pins.spiWrite(0xFF)
        }
        select()
        let r1 = sendCommand(Command.CMD0_GO_IDLE_STATE, 0)
        if (r1 !== R1Response.IDLE_STATE) {
            deselect()
            return false
        }
        r1 = sendCommand(Command.CMD8_SEND_IF_COND, 0x000001AA)
        if (r1 === R1Response.IDLE_STATE) {
            let r7 = readR7Response()
            if ((r7 & 0xFFF) !== 0x1AA) {
                deselect()
                return false
            }
            _cardType = CardType.SD_V2_SC
            let timeout = input.runningTime() + 2000
            while (input.runningTime() < timeout) {
                r1 = sendAppCommand(Command.ACMD41_SD_SEND_OP_COND, 0x40000000)
                if (r1 === R1Response.VALID_RESPONSE) {
                    break
                }
                basic.pause(10)
            }
            if (r1 !== R1Response.VALID_RESPONSE) {
                deselect()
                return false
            }
            r1 = sendCommand(Command.CMD58_READ_OCR, 0)
            if (r1 === R1Response.VALID_RESPONSE) {
                let ocr = readOCR()
                if (ocr & 0x40000000) {
                    _cardType = CardType.SD_V2_HC
                }
            }
        } else if ((r1 & R1Response.ILLEGAL_COMMAND) === 0) {
            _cardType = CardType.SD_V1
            let timeout = input.runningTime() + 2000
            while (input.runningTime() < timeout) {
                r1 = sendAppCommand(Command.ACMD41_SD_SEND_OP_COND, 0)
                if (r1 === R1Response.VALID_RESPONSE) {
                    break
                }
                basic.pause(10)
            }
            if (r1 !== R1Response.VALID_RESPONSE) {
                deselect()
                return false
            }
            sendCommand(Command.CMD16_SET_BLOCKLEN, 512)
        } else {
            deselect()
            return false
        }
        pins.spiFrequency(4000000)
        deselect()
        _initialized = true
        _sectorBuffer = pins.createBuffer(512)
        _bufferedSector = -1
        _bufferDirty = false
        return true
    }

    export function initializeFilesystem(): ErrorCode {
        if (!_initialized) {
            return ErrorCode.NOT_INITIALIZED
        }
        if (_sectorBuffer == null) {
            _sectorBuffer = pins.createBuffer(512)
        }
        if (!readSectorInto(0, _sectorBuffer)) {
            return ErrorCode.TIMEOUT
        }
        if (_sectorBuffer[510] !== 0x55 || _sectorBuffer[511] !== 0xAA) {
            return ErrorCode.INVALID_FS
        }
        _partitionStart = 0
        let partType = _sectorBuffer[0x1C2]
        if (partType === 0x04 || partType === 0x06 ||
            partType === 0x0B || partType === 0x0C || partType === 0x0E) {
            _partitionStart = readUInt32LE(_sectorBuffer, 0x1C6)
        }
        if (_partitionStart !== 0) {
            if (!readSectorInto(_partitionStart, _sectorBuffer)) {
                return ErrorCode.TIMEOUT
            }
        }
        if (_sectorBuffer[510] !== 0x55 || _sectorBuffer[511] !== 0xAA) {
            return ErrorCode.INVALID_FS
        }
        let bytesPerSector = readUInt16LE(_sectorBuffer, 11)
        if (bytesPerSector !== 512) {
            return ErrorCode.INVALID_FS
        }
        _sectorsPerCluster = _sectorBuffer[13]
        _reservedSectors = readUInt16LE(_sectorBuffer, 14)
        _numberOfFATs = _sectorBuffer[16]
        _rootEntryCount = readUInt16LE(_sectorBuffer, 17)
        let sectorsPerFAT16 = readUInt16LE(_sectorBuffer, 22)
        let sectorsPerFAT32 = readUInt32LE(_sectorBuffer, 36)
        if (sectorsPerFAT16 !== 0) {
            _fsType = FSType.FAT16
            _sectorsPerFAT = sectorsPerFAT16
            _rootCluster = 0
        } else {
            _fsType = FSType.FAT32
            _sectorsPerFAT = sectorsPerFAT32
            _rootCluster = readUInt32LE(_sectorBuffer, 44)
        }
        _fatStartSector = _partitionStart + _reservedSectors
        if (_fsType === FSType.FAT16) {
            _rootDirStartSector = _fatStartSector + (_numberOfFATs * _sectorsPerFAT)
            let rootDirSectors = Math.idiv((_rootEntryCount * 32) + 511, 512)
            _dataStartSector = _rootDirStartSector + rootDirSectors
        } else {
            _dataStartSector = _fatStartSector + (_numberOfFATs * _sectorsPerFAT)
            _rootDirStartSector = clusterToSector(_rootCluster)
        }
        _bufferedSector = -1
        _bufferDirty = false
        _fileOpen = false
        return ErrorCode.OK
    }

    /**
     * Initialize the SD card and filesystem
     */
    //% block="SD initialize"
    //% weight=100
    export function initialize(): boolean {
        if (!initializeCard()) {
            return false
        }
        return initializeFilesystem() === ErrorCode.OK
    }

    // ========== FAT OPERATIONS ==========

    function clusterToSector(cluster: number): number {
        return _dataStartSector + ((cluster - 2) * _sectorsPerCluster)
    }

    function readFATEntry(cluster: number): number {
        let fatOffset = (_fsType === FSType.FAT16) ? cluster * 2 : cluster * 4
        let fatSector = _fatStartSector + Math.idiv(fatOffset, 512)
        let entryOffset = fatOffset % 512
        let result = loadSector(fatSector)
        if (result !== ErrorCode.OK) {
            return 0xFFFFFFFF
        }
        if (_fsType === FSType.FAT16) {
            return readUInt16LE(_sectorBuffer, entryOffset)
        } else {
            return readUInt32LE(_sectorBuffer, entryOffset) & 0x0FFFFFFF
        }
    }

    function writeFATEntry(cluster: number, value: number): ErrorCode {
        let fatOffset = (_fsType === FSType.FAT16) ? cluster * 2 : cluster * 4
        for (let fat = 0; fat < _numberOfFATs; fat++) {
            let fatSector = _fatStartSector + (fat * _sectorsPerFAT) + Math.idiv(fatOffset, 512)
            let entryOffset = fatOffset % 512
            let result = loadSector(fatSector)
            if (result !== ErrorCode.OK) {
                return result
            }
            if (_fsType === FSType.FAT16) {
                writeUInt16LE(_sectorBuffer, entryOffset, value & 0xFFFF)
            } else {
                let existing = readUInt32LE(_sectorBuffer, entryOffset)
                writeUInt32LE(_sectorBuffer, entryOffset, (existing & 0xF0000000) | (value & 0x0FFFFFFF))
            }
            _bufferDirty = true
            result = flushBuffer()
            if (result !== ErrorCode.OK) {
                return result
            }
        }
        return ErrorCode.OK
    }

    function isEndOfChain(cluster: number): boolean {
        if (_fsType === FSType.FAT16) {
            return cluster >= 0xFFF8
        }
        return cluster >= 0x0FFFFFF8
    }

    function findFreeCluster(): number {
        let maxCluster = (_fsType === FSType.FAT16) ? 0xFFF7 : 0x0FFFFFF7
        for (let cluster = 2; cluster < maxCluster; cluster++) {
            let entry = readFATEntry(cluster)
            if (entry === 0) {
                return cluster
            }
        }
        return 0
    }

    function allocateCluster(previousCluster: number): number {
        let newCluster = findFreeCluster()
        if (newCluster === 0) {
            return 0
        }
        let endMark = (_fsType === FSType.FAT16) ? 0xFFFF : 0x0FFFFFFF
        writeFATEntry(newCluster, endMark)
        if (previousCluster !== 0) {
            writeFATEntry(previousCluster, newCluster)
        }
        let sector = clusterToSector(newCluster)
        let zeroBuffer = pins.createBuffer(512)
        zeroBuffer.fill(0)
        for (let i = 0; i < _sectorsPerCluster; i++) {
            writeSector(sector + i, zeroBuffer)
        }
        return newCluster
    }

    // ========== DIRECTORY OPERATIONS ==========

    function formatFilename(name: string): string {
        name = name.toUpperCase()
        let dotPos = name.indexOf(".")
        let baseName = ""
        let ext = ""
        if (dotPos >= 0) {
            baseName = name.substr(0, dotPos)
            ext = name.substr(dotPos + 1)
        } else {
            baseName = name
        }
        while (baseName.length < 8) {
            baseName = baseName + " "
        }
        baseName = baseName.substr(0, 8)
        while (ext.length < 3) {
            ext = ext + " "
        }
        ext = ext.substr(0, 3)
        return baseName + ext
    }

    function findFileEntry(filename: string): boolean {
        let formatted = formatFilename(filename)
        _foundSector = 0
        _foundOffset = 0
        _foundCluster = 0
        _foundSize = 0
        if (_fsType === FSType.FAT16) {
            let rootDirSectors = Math.idiv((_rootEntryCount * 32) + 511, 512)
            for (let s = 0; s < rootDirSectors; s++) {
                let result = loadSector(_rootDirStartSector + s)
                if (result !== ErrorCode.OK) {
                    return false
                }
                for (let e = 0; e < 16; e++) {
                    let offset = e * 32
                    let firstByte = _sectorBuffer[offset]
                    if (firstByte === 0x00) {
                        return false
                    }
                    if (firstByte === 0xE5) {
                        continue
                    }
                    let attr = _sectorBuffer[offset + 11]
                    if ((attr & 0x08) !== 0 || (attr & 0x10) !== 0) {
                        continue
                    }
                    let match = true
                    for (let i = 0; i < 11; i++) {
                        if (_sectorBuffer[offset + i] !== formatted.charCodeAt(i)) {
                            match = false
                            break
                        }
                    }
                    if (match) {
                        _foundSector = _rootDirStartSector + s
                        _foundOffset = offset
                        _foundCluster = readUInt16LE(_sectorBuffer, offset + 26)
                        _foundSize = readUInt32LE(_sectorBuffer, offset + 28)
                        return true
                    }
                }
            }
        } else {
            let cluster = _rootCluster
            while (!isEndOfChain(cluster)) {
                let sector = clusterToSector(cluster)
                for (let s = 0; s < _sectorsPerCluster; s++) {
                    let result = loadSector(sector + s)
                    if (result !== ErrorCode.OK) {
                        return false
                    }
                    for (let e = 0; e < 16; e++) {
                        let offset = e * 32
                        let firstByte = _sectorBuffer[offset]
                        if (firstByte === 0x00) {
                            return false
                        }
                        if (firstByte === 0xE5) {
                            continue
                        }
                        let attr = _sectorBuffer[offset + 11]
                        if ((attr & 0x08) !== 0 || (attr & 0x10) !== 0) {
                            continue
                        }
                        let match = true
                        for (let i = 0; i < 11; i++) {
                            if (_sectorBuffer[offset + i] !== formatted.charCodeAt(i)) {
                                match = false
                                break
                            }
                        }
                        if (match) {
                            let clusterHi = readUInt16LE(_sectorBuffer, offset + 20)
                            let clusterLo = readUInt16LE(_sectorBuffer, offset + 26)
                            _foundSector = sector + s
                            _foundOffset = offset
                            _foundCluster = (clusterHi << 16) | clusterLo
                            _foundSize = readUInt32LE(_sectorBuffer, offset + 28)
                            return true
                        }
                    }
                }
                cluster = readFATEntry(cluster)
            }
        }
        return false
    }

    function findFreeDirectoryEntry(): boolean {
        _foundSector = 0
        _foundOffset = 0
        if (_fsType === FSType.FAT16) {
            let rootDirSectors = Math.idiv((_rootEntryCount * 32) + 511, 512)
            for (let s = 0; s < rootDirSectors; s++) {
                let result = loadSector(_rootDirStartSector + s)
                if (result !== ErrorCode.OK) {
                    return false
                }
                for (let e = 0; e < 16; e++) {
                    let offset = e * 32
                    let firstByte = _sectorBuffer[offset]
                    if (firstByte === 0x00 || firstByte === 0xE5) {
                        _foundSector = _rootDirStartSector + s
                        _foundOffset = offset
                        return true
                    }
                }
            }
        } else {
            let cluster = _rootCluster
            let prevCluster = 0
            while (!isEndOfChain(cluster)) {
                let sector = clusterToSector(cluster)
                for (let s = 0; s < _sectorsPerCluster; s++) {
                    let result = loadSector(sector + s)
                    if (result !== ErrorCode.OK) {
                        return false
                    }
                    for (let e = 0; e < 16; e++) {
                        let offset = e * 32
                        let firstByte = _sectorBuffer[offset]
                        if (firstByte === 0x00 || firstByte === 0xE5) {
                            _foundSector = sector + s
                            _foundOffset = offset
                            return true
                        }
                    }
                }
                prevCluster = cluster
                cluster = readFATEntry(cluster)
            }
            let newCluster = allocateCluster(prevCluster)
            if (newCluster !== 0) {
                _foundSector = clusterToSector(newCluster)
                _foundOffset = 0
                return true
            }
        }
        return false
    }

    function createDirectoryEntry(filename: string, cluster: number): boolean {
        if (!findFreeDirectoryEntry()) {
            return false
        }
        let result = loadSector(_foundSector)
        if (result !== ErrorCode.OK) {
            return false
        }
        let formatted = formatFilename(filename)
        let offset = _foundOffset
        for (let i = 0; i < 11; i++) {
            _sectorBuffer[offset + i] = formatted.charCodeAt(i)
        }
        _sectorBuffer[offset + 11] = 0x20
        for (let i = 12; i < 26; i++) {
            _sectorBuffer[offset + i] = 0
        }
        if (_fsType === FSType.FAT32) {
            writeUInt16LE(_sectorBuffer, offset + 20, (cluster >> 16) & 0xFFFF)
        }
        writeUInt16LE(_sectorBuffer, offset + 26, cluster & 0xFFFF)
        writeUInt32LE(_sectorBuffer, offset + 28, 0)
        _bufferDirty = true
        flushBuffer()
        return true
    }

    function updateDirectoryEntry(): ErrorCode {
        if (!_fileOpen) {
            return ErrorCode.NO_FILE_OPEN
        }
        let result = flushBuffer()
        if (result !== ErrorCode.OK) {
            return result
        }
        _bufferedSector = -1
        result = loadSector(_fileDirEntrySector)
        if (result !== ErrorCode.OK) {
            return result
        }
        let off = _fileDirEntryOffset
        _sectorBuffer[off + 28] = _fileSize & 0xFF
        _sectorBuffer[off + 29] = (_fileSize >> 8) & 0xFF
        _sectorBuffer[off + 30] = (_fileSize >> 16) & 0xFF
        _sectorBuffer[off + 31] = (_fileSize >> 24) & 0xFF
        _sectorBuffer[off + 26] = _fileStartCluster & 0xFF
        _sectorBuffer[off + 27] = (_fileStartCluster >> 8) & 0xFF
        if (_fsType === FSType.FAT32) {
            _sectorBuffer[off + 20] = (_fileStartCluster >> 16) & 0xFF
            _sectorBuffer[off + 21] = (_fileStartCluster >> 24) & 0xFF
        }
        _bufferDirty = true
        return flushBuffer()
    }

    // ========== FILE OPERATIONS ==========

    /**
     * Open a file for reading, writing, or appending
     * @param filename The filename (8.3 format)
     * @param mode File open mode
     */
    //% block="SD open file $filename for $mode"
    //% weight=90
    export function openFile(filename: string, mode: FileMode): ErrorCode {
        if (!_initialized || _fsType === FSType.UNKNOWN) {
            return ErrorCode.NOT_INITIALIZED
        }
        if (_fileOpen) {
            closeFile()
        }
        let found = findFileEntry(filename)
        if (mode === FileMode.READ) {
            if (!found) {
                return ErrorCode.FILE_NOT_FOUND
            }
            _fileStartCluster = _foundCluster
            _fileSize = _foundSize
            _fileDirEntrySector = _foundSector
            _fileDirEntryOffset = _foundOffset
            _filePosition = 0
            _currentCluster = _fileStartCluster
            _clusterOffset = 0
        } else if (mode === FileMode.WRITE) {
            if (found) {
                let cluster = _foundCluster
                while (cluster !== 0 && !isEndOfChain(cluster)) {
                    let next = readFATEntry(cluster)
                    writeFATEntry(cluster, 0)
                    cluster = next
                }
                _fileDirEntrySector = _foundSector
                _fileDirEntryOffset = _foundOffset
            }
            _fileStartCluster = allocateCluster(0)
            if (_fileStartCluster === 0) {
                return ErrorCode.DISK_FULL
            }
            if (!found) {
                if (!createDirectoryEntry(filename, _fileStartCluster)) {
                    return ErrorCode.DISK_FULL
                }
                _fileDirEntrySector = _foundSector
                _fileDirEntryOffset = _foundOffset
            } else {
                let result = loadSector(_fileDirEntrySector)
                if (result !== ErrorCode.OK) {
                    return result
                }
                if (_fsType === FSType.FAT32) {
                    writeUInt16LE(_sectorBuffer, _fileDirEntryOffset + 20, (_fileStartCluster >> 16) & 0xFFFF)
                }
                writeUInt16LE(_sectorBuffer, _fileDirEntryOffset + 26, _fileStartCluster & 0xFFFF)
                writeUInt32LE(_sectorBuffer, _fileDirEntryOffset + 28, 0)
                _bufferDirty = true
                flushBuffer()
            }
            _fileSize = 0
            _filePosition = 0
            _currentCluster = _fileStartCluster
            _clusterOffset = 0
        } else if (mode === FileMode.APPEND) {
            if (!found) {
                _fileStartCluster = allocateCluster(0)
                if (_fileStartCluster === 0) {
                    return ErrorCode.DISK_FULL
                }
                if (!createDirectoryEntry(filename, _fileStartCluster)) {
                    return ErrorCode.DISK_FULL
                }
                _fileDirEntrySector = _foundSector
                _fileDirEntryOffset = _foundOffset
                _fileSize = 0
                _filePosition = 0
                _currentCluster = _fileStartCluster
                _clusterOffset = 0
            } else {
                _fileStartCluster = _foundCluster
                _fileSize = _foundSize
                _fileDirEntrySector = _foundSector
                _fileDirEntryOffset = _foundOffset
                _filePosition = _fileSize
                let bytesPerCluster = _sectorsPerCluster * 512
                let clusterIndex = Math.idiv(_fileSize, bytesPerCluster)
                _clusterOffset = _fileSize % bytesPerCluster
                _currentCluster = _fileStartCluster
                for (let i = 0; i < clusterIndex; i++) {
                    if (isEndOfChain(_currentCluster)) {
                        break
                    }
                    _currentCluster = readFATEntry(_currentCluster)
                }
            }
        }
        _fileMode = mode
        _fileOpen = true
        return ErrorCode.OK
    }

    /**
     * Close the currently open file
     */
    //% block="SD close file"
    //% weight=85
    export function closeFile(): ErrorCode {
        if (!_fileOpen) {
            return ErrorCode.OK
        }
        flushBuffer()
        let result = ErrorCode.OK
        if (_fileMode !== FileMode.READ) {
            result = updateDirectoryEntry()
        }
        _fileOpen = false
        _fileStartCluster = 0
        _fileSize = 0
        _filePosition = 0
        _currentCluster = 0
        _clusterOffset = 0
        _fileDirEntrySector = 0
        _fileDirEntryOffset = 0
        return result
    }

    /**
     * Write a string to the open file
     * @param text The text to write
     */
    //% block="SD write $text"
    //% weight=80
    export function writeString(text: string): ErrorCode {
        if (!_fileOpen) {
            return ErrorCode.NO_FILE_OPEN
        }
        if (_fileMode === FileMode.READ) {
            return ErrorCode.INVALID_PARAM
        }
        let buf = pins.createBuffer(text.length)
        for (let i = 0; i < text.length; i++) {
            buf[i] = text.charCodeAt(i) & 0xFF
        }
        return writeBuffer(buf)
    }

    export function writeBuffer(data: Buffer): ErrorCode {
        if (!_fileOpen) {
            return ErrorCode.NO_FILE_OPEN
        }
        if (_fileMode === FileMode.READ) {
            return ErrorCode.INVALID_PARAM
        }
        if (data == null) {
            return ErrorCode.INVALID_PARAM
        }
        let bytesToWrite = data.length
        let dataOffset = 0
        let bytesPerCluster = _sectorsPerCluster * 512
        while (bytesToWrite > 0) {
            let sectorInCluster = Math.idiv(_clusterOffset, 512)
            let offsetInSector = _clusterOffset % 512
            let sector = clusterToSector(_currentCluster) + sectorInCluster
            let result = loadSector(sector)
            if (result !== ErrorCode.OK) {
                return result
            }
            let bytesInSector = Math.min(bytesToWrite, 512 - offsetInSector)
            for (let i = 0; i < bytesInSector; i++) {
                _sectorBuffer[offsetInSector + i] = data[dataOffset + i]
            }
            _bufferDirty = true
            dataOffset += bytesInSector
            bytesToWrite -= bytesInSector
            _clusterOffset += bytesInSector
            _filePosition += bytesInSector
            if (_filePosition > _fileSize) {
                _fileSize = _filePosition
            }
            if (_clusterOffset >= bytesPerCluster) {
                let flushResult = flushBuffer()
                if (flushResult !== ErrorCode.OK) {
                    return flushResult
                }
                let nextCluster = readFATEntry(_currentCluster)
                if (isEndOfChain(nextCluster)) {
                    if (bytesToWrite > 0) {
                        nextCluster = allocateCluster(_currentCluster)
                        if (nextCluster === 0) {
                            updateDirectoryEntry()
                            return ErrorCode.DISK_FULL
                        }
                    }
                }
                if (!isEndOfChain(nextCluster)) {
                    _currentCluster = nextCluster
                    _clusterOffset = 0
                }
            }
        }
        return ErrorCode.OK
    }

    /**
     * Write a line (text + newline) to the open file
     * @param text The text to write
     */
    //% block="SD write line $text"
    //% weight=78
    export function writeLine(text: string): ErrorCode {
        let result = writeString(text)
        if (result !== ErrorCode.OK) {
            return result
        }
        return writeString("\r\n")
    }

    export function readBytes(length: number): Buffer {
        if (!_fileOpen) {
            return null
        }
        let remaining = _fileSize - _filePosition
        if (remaining <= 0) {
            return pins.createBuffer(0)
        }
        let bytesToRead = Math.min(length, remaining)
        let resultBuf = pins.createBuffer(bytesToRead)
        let dataOffset = 0
        let bytesPerCluster = _sectorsPerCluster * 512
        while (bytesToRead > 0) {
            let sectorInCluster = Math.idiv(_clusterOffset, 512)
            let offsetInSector = _clusterOffset % 512
            let sector = clusterToSector(_currentCluster) + sectorInCluster
            let loadResult = loadSector(sector)
            if (loadResult !== ErrorCode.OK) {
                return null
            }
            let bytesInSector = Math.min(bytesToRead, 512 - offsetInSector)
            for (let i = 0; i < bytesInSector; i++) {
                resultBuf[dataOffset + i] = _sectorBuffer[offsetInSector + i]
            }
            dataOffset += bytesInSector
            bytesToRead -= bytesInSector
            _clusterOffset += bytesInSector
            _filePosition += bytesInSector
            if (_clusterOffset >= bytesPerCluster) {
                let nextCluster = readFATEntry(_currentCluster)
                if (!isEndOfChain(nextCluster)) {
                    _currentCluster = nextCluster
                    _clusterOffset = 0
                }
            }
        }
        return resultBuf
    }

    export function readString(length: number): string {
        let buf = readBytes(length)
        if (buf == null) {
            return ""
        }
        let str = ""
        for (let i = 0; i < buf.length; i++) {
            str += String.fromCharCode(buf[i])
        }
        return str
    }

    /**
     * Read a line from the open file
     */
    //% block="SD read line"
    //% weight=73
    export function readLine(): string {
        let line = ""
        let maxLen = 256
        while (line.length < maxLen && _filePosition < _fileSize) {
            let ch = readString(1)
            if (ch === "") {
                break
            }
            if (ch === "\n") {
                break
            }
            if (ch !== "\r") {
                line += ch
            }
        }
        return line
    }

    export function seek(position: number): ErrorCode {
        if (!_fileOpen) {
            return ErrorCode.NO_FILE_OPEN
        }
        if (position < 0) {
            position = 0
        }
        if (position > _fileSize) {
            position = _fileSize
        }
        flushBuffer()
        let bytesPerCluster = _sectorsPerCluster * 512
        let clusterIndex = Math.idiv(position, bytesPerCluster)
        _currentCluster = _fileStartCluster
        for (let i = 0; i < clusterIndex; i++) {
            if (isEndOfChain(_currentCluster)) {
                break
            }
            _currentCluster = readFATEntry(_currentCluster)
        }
        _clusterOffset = position % bytesPerCluster
        _filePosition = position
        return ErrorCode.OK
    }

    export function getPosition(): number {
        return _filePosition
    }

    export function getFileSize(): number {
        return _fileSize
    }

    /**
     * Check if at end of file
     */
    //% block="SD end of file"
    //% weight=67
    export function isEndOfFile(): boolean {
        return _filePosition >= _fileSize
    }

    export function fileExists(filename: string): boolean {
        return findFileEntry(filename)
    }

    export function deleteFile(filename: string): ErrorCode {
        if (!_initialized || _fsType === FSType.UNKNOWN) {
            return ErrorCode.NOT_INITIALIZED
        }
        if (!findFileEntry(filename)) {
            return ErrorCode.FILE_NOT_FOUND
        }
        let cluster = _foundCluster
        while (cluster !== 0 && !isEndOfChain(cluster)) {
            let next = readFATEntry(cluster)
            writeFATEntry(cluster, 0)
            cluster = next
        }
        let result = loadSector(_foundSector)
        if (result !== ErrorCode.OK) {
            return result
        }
        _sectorBuffer[_foundOffset] = 0xE5
        _bufferDirty = true
        return flushBuffer()
    }

    // ========== STATUS FUNCTIONS ==========

    export function getCardType(): CardType {
        return _cardType
    }

    export function getFilesystemType(): FSType {
        return _fsType
    }

    /**
     * Check if the SD card is initialized and ready
     */
    //% block="SD is ready"
    //% weight=48
    export function isReady(): boolean {
        return _initialized && _fsType !== FSType.UNKNOWN
    }

    export function isFileOpen(): boolean {
        return _fileOpen
    }

    export function flush(): ErrorCode {
        let result = flushBuffer()
        if (result !== ErrorCode.OK) {
            return result
        }
        if (_fileOpen && _fileMode !== FileMode.READ) {
            return updateDirectoryEntry()
        }
        return ErrorCode.OK
    }
}
