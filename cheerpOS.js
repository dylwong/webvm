// Copyright 2017-2021 Leaning Technologies Ltd. All Rights Reserved.

// An array of {path:"/path",handler:handlerObj} ordered by the most specific to the least
var cheerpjFSMounts = [];
// An array of resources loaded from the runtime
var cheerpjRuntimeResources = [];
var cosFileWatchPrefixes = {};

function cheerpjFSInit(appUrlPrefix, jarJsOverridePath, loaderPath)
{
	// Keep these ordered from the most specific to the least
	cheerpjFSMounts.push(new CheerpJWebFolder("/app/", appUrlPrefix ? appUrlPrefix : "", false, jarJsOverridePath, null, DirectDownloader));
	cheerpjFSMounts.push(new CheerpJWebFolder("/apps/", appUrlPrefix ? appUrlPrefix : "", true, null, null, DirectDownloader));
	cheerpjFSMounts.push(new CheerpJIndexedDBFolder("/files/"));
	cheerpjFSMounts.push(new CheerpJWebFolder("/lt/", loaderPath, false, null, cheerpjRuntimeResources, DirectDownloader));
	cheerpjFSMounts.push(new CheerpJWebFolder("/lts/", loaderPath, true, null, cheerpjRuntimeResources, DirectDownloader));
	cheerpjFSMounts.push(new CheerpJDataFolder("/str/"));
	cheerpjFSMounts.push(new CheerpJDevFolder("/dev/"));
	cheerpjFSMounts.push(new CheerpJRootFolder("/"));
	var conFileData = cheerpjCreateConsole(null, null, cheerpjDefaultConsoleWrite);
	var conFD = { fileData: conFileData, offset: 0, flags: 0 };
	cjFDs[0] = conFD;
	cjFDs[1] = conFD;
	cjFDs[2] = conFD;
	conFileData.refCount+=3;
}

function CheerpJFileData(parent, path, len, inodeId, permType, lastModified)
{
	this.refCount = 0;
	this.cacheRefCount = 0;
	this.length = len | 0;
	this.dirty = 0;
	this.parent = parent;
	// path is local to the mount point
	this.path = path;
	this.inodeId = inodeId | 0;
	// data is linear not chunked data
	this.data = null;
	// chunks is for chunked data
	this.chunks = null;
	// mount contains the ops structure
	this.mount = null;
	// permissions and file type following 'stat' conventions
	this.permType = permType | 0;
	// last modification time, seconds from epoch
	this.lastModified = lastModified | 0;
	// bufId of the canonical linear memory
	this.bufId = 0;
}

CheerpJFileData.S_IFCHR = 0x2000;
CheerpJFileData.S_IFDIR = 0x4000;
CheerpJFileData.S_IFREG = 0x8000;
CheerpJFileData.S_IFSOCK = 0xc000;
CheerpJFileData.S_IFMT = 0xf000;

function CheerpJFolder(mp)
{
	this.mountPoint = mp;
	this.isSplit = false;
	// { statAsync, listAsync, makeFileData, createDirAsync, renameAsync, unlinkAsync }
	this.mountOps = null;
	// { readAsync, writeAsync, commitFileData };
	this.inodeOps = null;
	this.devId = CheerpJFolder.lastDevId;
	// Contains inodes
	this.fileCache = {};
	this.cacheThreads = {};
	// Contains CheerpJFileData entries
	this.inodeCache = [];
	CheerpJFolder.lastDevId = CheerpJFolder.lastDevId + 1|0
}

function folderDecRefCached(fileName, fileData)
{
	fileData.cacheRefCount = fileData.cacheRefCount-1|0;
	if(fileData.cacheRefCount==0)
	{
		assert(this.inodeCache[fileData.inodeId]);
		delete this.inodeCache[fileData.inodeId];
	}
}

function folderGetCached(fileName)
{
	var c = this.fileCache;
	if(!c.hasOwnProperty(fileName))
		return null;
	var inodeId = c[fileName];
	var ret = this.inodeCache[inodeId];
	assert(ret);
	return ret;
}

function folderSetCached(fileName, fileData)
{
	var c = this.fileCache;
	fileData.cacheRefCount = fileData.cacheRefCount+1|0;
	if(c.hasOwnProperty(fileName))
		this.decRefCached(fileName, c[fileName]);
	var inodeId = fileData.inodeId;
	c[fileName] = inodeId;
	this.inodeCache[inodeId] = fileData;
}

function folderClearCached(fileName)
{
	var c = this.fileCache;
	if(c.hasOwnProperty(fileName))
	{
		var inodeId = c[fileName];
		var data = this.inodeCache[inodeId];
		assert(data);
		this.decRefCached(fileName, data);
		delete c[fileName];
	}
}

CheerpJFolder.lastDevId = 1;
CheerpJFolder.prototype.getCached = folderGetCached;
CheerpJFolder.prototype.setCached = folderSetCached;
CheerpJFolder.prototype.decRefCached = folderDecRefCached;
CheerpJFolder.prototype.clearCached = folderClearCached;

function CheerpJRootFolder(mp)
{
	CheerpJFolder.call(this, mp);
	this.mountOps = RootOps;
}

CheerpJRootFolder.prototype = Object.create(CheerpJFolder.prototype);

function rootStatAsync(mp, path, fileRef, cb)
{
	if(path == "/")
	{
		fileRef.permType = CheerpJFileData.S_IFDIR | 0555;
		// Use the dev id as the inode id
		fileRef.inodeId = 0;
		return cb();
	}
	// Iterate over the mount points
	for(var i=0;i<cheerpjFSMounts.length;i++)
	{
		var f = cheerpjFSMounts[i];
		if(f.mountPoint == path + "/")
		{
			fileRef.permType = CheerpJFileData.S_IFDIR | 0555;
			// Use the dev id as the inode id
			fileRef.inodeId = f.devId;
			return cb();
		}
	}
	fileRef.permType = 0;
	return cb();
}

function rootListAsync(mp, path, fileRef, cb)
{
	// Only the root itself can be listed
	if(path != "/"){
		return cb();
	}
	for(var i=0;i<cheerpjFSMounts.length-1;i++)
	{
		var f = cheerpjFSMounts[i];
		fileRef.push(f.mountPoint);
	}
	return cb();
}

var RootOps = { statAsync: rootStatAsync, listAsync: rootListAsync, makeFileData: null, createDirAsync: null, renameAsync: null, linkAsync: null, unlinkAsync: null };

function CheerpJWebFolder(mp, basePath, isSplit, jarJSOverride, resTrace, downloader)
{
	CheerpJFolder.call(this, mp);
	this.mountOps = WebOps;
	this.inodeOps = WebInodeOps;
	this.basePath = basePath;
	this.isSplit = isSplit;
	this.jarJSOverride = jarJSOverride;
	// Make this a member as it needs to be overridden for jnlp support
	this.mapPath = webMapPath;
	// We need to assign unique ids to each file, and they must persist over the lifetime of the application
	this.inodeMap = {}
	this.lastInode = 1;
	// Either null or an array, use to profile loaded resources
	this.resTrace = resTrace;
	this.downloader = downloader;
	this.chunkSize = 128 * 1024;
}

CheerpJWebFolder.prototype = Object.create(CheerpJFolder.prototype);

function webGetInode(mp, path)
{
	var ret = mp.inodeMap[path];
	if(ret !== undefined){
		return ret;
	}
	ret = {inodeId:mp.lastInode, permType:0, fileLength:0};
	mp.lastInode = mp.lastInode + 1|0;
	mp.inodeMap[path] = ret;
	return ret;
}

function DirectDownloader(url, method, accumulate)
{
	this.url = url;
	this.accumulate = accumulate;
	this.method = method;
	this.responseURL = null;
	this.response = null;
	this.fileLength = -1;
	this.failCount = 0;
	this.tmpChunk = null;
	this.currOffs = 0;
}

function cheerpOSSafeContentLength(contentLengthStr, contentEncodingStr, etagStr, lastModifiedStr)
{
	if(contentEncodingStr == null && contentLengthStr != null)
	{
		// No compression, we can trust the content-length
		return parseInt(contentLengthStr);
	}
	// Either compressed or without content-length, try to extract data from the ETag
	if(etagStr == null)
		return -1;
	var origEtagStr = etagStr;
	// 1) Drop the weak prefix, if needed
	if(etagStr.startsWith("W/"))
		etagStr = etagStr.substr(2);
	// 2) Expect quotes
	if(!etagStr.startsWith('"') || !etagStr.endsWith('"'))
		return -1;
	etagStr = etagStr.substring(1, etagStr.length - 1);
	// 3) Split into dash separated segments and try to match known structures
	var segments = etagStr.split("-");
	// Syntax:
	// LLLL - Length, in hex
	// MMMM - Last modified
	function isHex(s)
	{
		return parseInt(s, 16).toString(16) == s;
	}
	// 3) Nginx: W/"MMMM-LLLL"
	if(origEtagStr.startsWith("W/") && segments.length == 2 && isHex(segments[0]) && isHex(segments[1]))
		return parseInt(segments[1], 16);
	// 4) Apache: "LLLL-MMMM-gzip"
	if(segments.length == 3 && isHex(segments[0]) && isHex(segments[1]) && segments[2] == "gzip")
		return parseInt(segments[0], 16);
	return -1;
}

function ddlOnLoad(resp, downloader)
{
	if(resp.status == 200)
	{
		downloader.responseURL = resp.url;
		if(downloader.responseURL.endsWith("/"))
			downloader.fileLength = 0;
		else
		{
			var safeContentLength = cheerpOSSafeContentLength(resp.headers.get("Content-Length"), resp.headers.get("Content-Encoding"), resp.headers.get("ETag"), resp.headers.get("Last-Modified"));
			if(safeContentLength >= 0)
				downloader.fileLength = safeContentLength;
			else if(downloader.method == "HEAD")
			{
				// No good header? Try again with GET
				downloader.method = "GET";
				downloader.send();
				return;
			}
			else
			{
				downloader.onStart(resp);
				if(downloader.accumulate)
				{
					downloader.tmpChunk = [];
				}
				ddlOnData(downloader, resp.body.getReader());
				downloader.lastModified = resp.headers.get("Last-Modified");
				return;
			}
		}
		downloader.lastModified = resp.headers.get("Last-Modified");
	}
	else if(resp.status == 204 || resp.status == 231 || resp.status == 403 || resp.status == 404)
	{
		downloader.responseURL = resp.url;
		if(resp.status == 231)
			downloader.responseURL += "/";
		downloader.onStart(resp);
		downloader.onEnd();
		return;
	}
	else if(resp.status == 501)
	{
		// Some incredibily broken HTTP servers do not implement HEAD, try again with GET
		downloader.method = "GET";
		downloader.send();
		return;
	}
	else if(resp.status >= 500 && resp.status < 600)
	{
		ddlOnError(downloader, e);
		return;
	}
	downloader.onStart(resp);
	if(downloader.accumulate)
	{
		downloader.tmpChunk = [];
	}
	if(downloader.method == "HEAD")
		downloader.onEnd(downloader);
	else
		ddlOnData(downloader, resp.body.getReader());
}

function ddlOnData(downloader, reader)
{
	reader.read()
		.then(function(result){
			downloader.onData(result);
			if(!result.done)
			{
				var data = result.value;
				if(downloader.accumulate)
				{
					downloader.tmpChunk.push(data);
				}
				downloader.currOffs += data.length;
				ddlOnData(downloader, reader);
			}
			else
			{
				if(downloader.accumulate)
				{
					var tmp = downloader.tmpChunk;
					downloader.tmpChunk = new Uint8Array(downloader.currOffs);
					var cnt = 0;
					for(var i = 0; i < tmp.length; i++)
					{
						for(var k = 0; k < tmp[i].length; k++)
						{
							downloader.tmpChunk[cnt++] = tmp[i][k];
						}
					}
				}
				downloader.fileLength = downloader.currOffs;
				downloader.onEnd();
			}
		});
}

function ddlOnError(downloader, err)
{
	downloader.failCount++;
	if(downloader.failCount > 5)
	{
		cjReportError("Network error "+ downloader.url);
		return;
	}
	// Try again
	downloader.send();
}

function ddlSend()
{
	var downloader = this;
	fetch(this.url, {"method": this.method, "mode": "cors"})
		.then(function(response){
			ddlOnLoad(response, downloader);
		})
		.catch(function(err){
			if ((downloader.url.indexOf("://") >= 0 && downloader.url.startsWith("chrome-extension:"))
				|| window.location.protocol == "chrome-extension:")
			{
				// Extension urls return an error if the file 
				// does not exist, but we want to treat this case as
				// a 404. Check if the path is a directory, and if
				// so manually add a "/" to the path.
				fetch(downloader.url+"/index.list")
					.then(function(r){
						var response = {
							status: 404,
							url: downloader.url+"/",
						};
						ddlOnLoad(response, downloader);
					})
					.catch(function(err){
						var response = {
							status: 404,
							url: downloader.url,
						};
						ddlOnLoad(response, downloader);
					});
				return;
			}
			ddlOnError(downloader, err);
		});
}

DirectDownloader.prototype.send = ddlSend;
DirectDownloader.prototype.onData = function(){};
DirectDownloader.prototype.onEnd = function(){};
DirectDownloader.prototype.onStart = function(){};

function webGetAsyncImpl(mp, path, fileRef, method, cb)
{
	if(path == "")
	{
		var ci = webGetInode(mp, path);
		fileRef.inodeId = ci.inodeId;
		fileRef.permType = ci.permType = CheerpJFileData.S_IFDIR | 0555;
		return cb();
	}
	var url = mp.mapPath(mp, path);
	var dl = new mp.downloader(url, method, /*accumulate*/method == "GET");

	dl.onEnd = function() {
		var inodeId = 0;
		var permType = 0;
		var cheerpjDownload = null;
		if(this.responseURL && this.responseURL.endsWith("/"))
		{
			var ci = webGetInode(mp, path);
			inodeId = ci.inodeId;
			permType = ci.permType = CheerpJFileData.S_IFDIR | 0555;
		}
		else if(this.tmpChunk)
		{
			var ci = webGetInode(mp, path);
			inodeId = ci.inodeId;
			permType = ci.permType = CheerpJFileData.S_IFREG | 0444;
			fileRef.fileLength = ci.fileLength = this.tmpChunk.byteLength;
			cheerpjDownload = new Uint8Array(this.tmpChunk);
		}
		else if(this.fileLength >= 0)
		{
			var ci = webGetInode(mp, path);
			inodeId = ci.inodeId;
			permType = ci.permType = CheerpJFileData.S_IFREG | 0444;
			fileRef.fileLength = ci.fileLength = this.fileLength;
		}
		fileRef.permType = permType | 0;
		fileRef.inodeId = inodeId | 0;
		if(this.lastModified)
			fileRef.lastModified = (Date.parse(this.lastModified) / 1000) | 0;
		else
			fileRef.lastModified = 0;
		fileRef.cheerpjDownload = cheerpjDownload;
		return cb();
	};
	dl.send();
}

function webStatAsync(mp, path, fileRef, cb)
{
	var ci = mp.inodeMap[path];
	if(ci !== undefined)
	{
		fileRef.fileLength = ci.fileLength | 0;
		fileRef.inodeId = ci.inodeId | 0;
		fileRef.permType = ci.permType | 0;
		return cb();
	}
	webGetAsyncImpl(mp, path, fileRef, "HEAD", cb);
}

function webMapPath(mp, path)
{
	if(mp.resTrace)
	{
		var res = mp.mountPoint + path.substr(1);
		if(mp.resTrace.indexOf(res) < 0)
			mp.resTrace.push(res);
	}
	if(path.endsWith(".jar.js") && mp.jarJSOverride){
		return mp.jarJSOverride + path;
	}else{
		return mp.basePath + path;
	}
}

function webMakeFileData(mp, path, mode, cb)
{
	assert(mode == "r");
	var fileRef={}
	mp.mountOps.statAsync(mp, path, fileRef, function(){
	if(fileRef.permType === 0)
		return cb(null);
	// Prepare chunks
	var numChunks = ((fileRef.fileLength + (mp.chunkSize-1)) / mp.chunkSize) | 0;
	var chunks = [];
	for(var i=0;i<numChunks;i++)
		chunks[i] = null;
	var fileData = new CheerpJFileData(mp, path, fileRef.fileLength|0, fileRef.inodeId|0, fileRef.permType|0, /*lastModified*/0);
	fileData.mount = mp.inodeOps;
	fileData.chunks = chunks;
	if((fileRef.permType & CheerpJFileData.S_IFMT) != CheerpJFileData.S_IFREG){
		return cb(fileData);
	}
	if(!mp.isSplit)
	{
		for(var i=0;i<numChunks;i++)
			chunks[i] = [];
		fileData.chunkSize = mp.chunkSize;
		var url = mp.mapPath(mp, path);
		var dl = new mp.downloader(url, "GET", /*accumulate*/false);
		dl.fileData = fileData;
		dl.onStart = function()
		{
			this.chunk = new Uint8Array(this.fileData.chunkSize);
			this.curOffs = 0;
			this.curChunk = 0;
		}
		dl.onData = function(res)
		{
			if(!res.done)
			{
				var data = res.value;
				for(var i = 0; i < data.length; i++)
				{
					this.chunk[this.curOffs++] = data[i];
					if(this.curOffs >= this.chunk.length)
					{
						var tmp = this.fileData.chunks[this.curChunk];
						this.fileData.chunks[this.curChunk++] = new Uint8Array(this.chunk);
						this.curOffs = 0;
						for(var k = 0; k < tmp.length; k++)
						{
							var cb = tmp[k];
							cb();
						}
					}
				}
			}
		}
		dl.onEnd = function()
		{
			if(this.curOffs != 0)
			{
				var tmp = this.fileData.chunks[this.curChunk];
				this.fileData.chunks[this.curChunk] = new Uint8Array(this.fileData.chunkSize);
				this.fileData.chunks[this.curChunk].set(this.chunk, 0);
				for(var k = 0; k < tmp.length; k++)
				{
					var cb = tmp[k];
					cb();
				}
			}
		}
		dl.send();
	}
	return cb(fileData);
	});
}

function webReadAsync(fileData, fileOffset, buf, off, len, flags, cb)
{
	assert(fileOffset <= fileData.length);
	if(fileOffset + len > fileData.length) len = fileData.length - fileOffset;
	// EOF
	if(len == 0){
		return cb(0);
	}
	var chunkSize = fileData.parent.chunkSize;
	var startChunk = fileOffset / chunkSize | 0;
	var curChunk = startChunk;
	var endChunk = (fileOffset + len) / chunkSize | 0;
	var fileRef={chunks:fileData.chunks, pendingLoads: 0, oldOnEnd: null};
	return webReadAsyncLoop(fileData, fileOffset, buf, off, len, flags, fileRef, startChunk, curChunk, endChunk, cb);
}

function webReadAsyncLoop(fileData, fileOffset, buf, off, len, flags, fileRef, startChunk, curChunk, endChunk, cb)
{
	while(curChunk <= endChunk){
		if(fileData.chunks[curChunk] instanceof Uint8Array)
		{
			var curChunk = curChunk+1|0;
			continue;
		}
		if(!(fileData.parent.isSplit))
		{
			fileData.chunks[endChunk].push(function()
			{
				webReadAsyncLoop(fileData, fileOffset, buf, off, len, flags, fileRef, startChunk, curChunk, endChunk, cb);
			});
			return;
		}
		fileRef.pendingLoads++;
		if(fileData.chunks[curChunk])
		{
			// Pending load, override the onEnd handler
			fileData.chunks[curChunk].oldOnEnd = fileData.chunks[curChunk].onEnd;
			fileData.chunks[curChunk].onEnd = function()
			{
				this.oldOnEnd();
				fileRef.pendingLoads--;
				if(fileRef.pendingLoads == 0)
				{
					return webReadAsyncEnd(fileData, fileOffset, buf, off, len, flags, fileRef, curChunk, endChunk, cb);
				}
			};
		}
		else
		{
			var url = webMapPath(fileData.parent, fileData.path + ".c" + curChunk + ".txt");
			var dl = new fileData.parent.downloader(url, "GET", /*accumulate*/true);
			fileRef.chunks[curChunk] = dl;
			dl.curChunk = curChunk;
			dl.onEnd = function()
			{
				fileRef.chunks[this.curChunk] = new Uint8Array(this.tmpChunk);
				fileRef.pendingLoads--;
				if(fileRef.pendingLoads == 0)
				{
					return webReadAsyncEnd(fileData, fileOffset, buf, off, len, flags, fileRef, curChunk, endChunk, cb);
				}
			};
			dl.send();
		}
		curChunk = curChunk+1|0;
	}
	// Do read-ahead, but do not wait for the results
	var fwdAhead = endChunk + 1;
	var bwdAhead = startChunk - 1;
	if(fwdAhead < fileData.chunks.length && fileData.chunks[fwdAhead] == null)
	{
		var url = webMapPath(fileData.parent, fileData.path + ".c" + fwdAhead + ".txt");
		var dl = new fileData.parent.downloader(url, "GET", /*accumulate*/ true);
		fileRef.chunks[fwdAhead] = dl;
		dl.curChunk = fwdAhead;
		dl.onEnd = function()
		{
			fileRef.chunks[this.curChunk] = new Uint8Array(this.tmpChunk);
		};
		dl.send();
	}
	else if(bwdAhead >= 0 && fileData.chunks[bwdAhead] == null)
	{
		var url = webMapPath(fileData.parent, fileData.path + ".c" + bwdAhead + ".txt");
		var dl = new fileData.parent.downloader(url, "GET", /*accumulate*/true);
		fileRef.chunks[bwdAhead] = dl;
		dl.curChunk = bwdAhead;
		dl.onEnd = function()
		{
			fileRef.chunks[this.curChunk] = new Uint8Array(this.tmpChunk);
		};
		dl.send();
	}
	if(fileRef.pendingLoads !== 0){
		return;
	}
	return webReadAsyncEnd(fileData, fileOffset, buf, off, len, flags, fileRef, curChunk, endChunk, cb);
}

function webReadAsyncEnd(fileData, fileOffset, buf, off, len, flags, fileRef, curChunk, endChunk, cb)
{
	// All chunks are now loaded
	var chunkSize = fileData.parent.chunkSize;
	var curChunk = fileOffset / chunkSize | 0;
	var curOffset = fileOffset - (curChunk*chunkSize) | 0;
	var i=0;
	while(i<len)
	{
		var c = fileData.chunks[curChunk];
		if((len-i) < (chunkSize-curOffset))
			chunkSize = curOffset+(len-i);
		for(var j=curOffset;j<chunkSize;j++)
		{
			buf[off+i|0]=c[j];
			i++;
		}
		curChunk++;
		curOffset=0;
	}
	assert(i===len);
	return cb(len);
}

function webListAsync(mp, path, fileRef, cb)
{
	var url = mp.mapPath(mp, path+"/index.list");
	var dl = new mp.downloader(url, "GET", /*accumulate*/true);
	dl.fileRef = fileRef;
	dl.onEnd = function()
	{
		if(this.tmpChunk)
		{
			let res = "";
			for(var i = 0; i < this.tmpChunk.length; i++)
			{
				res += String.fromCharCode(this.tmpChunk[i]);
			}
			var files = res.split("\n");
			for(var i=0;i<files.length;i++)
			{
				if(files[i].length)
					fileRef.push(files[i]);
			}
		}
		cb();
	};
	dl.send();
}

var WebOps = { statAsync: webStatAsync, listAsync: webListAsync, makeFileData: webMakeFileData, createDirAsync: null, renameAsync: null, linkAsync: null, unlinkAsync: null };
var WebInodeOps = { readAsync: webReadAsync, writeAsync: null, commitFileData: null };

function CheerpJIndexedDBFolder(mp)
{
	CheerpJFolder.call(this, mp);
	this.mountOps = IdbOps;
	this.inodeOps = IdbInodeOps;
	this.isSplit = true;
	this.dbConnection = null;
	this.dEntries = {};
}

CheerpJIndexedDBFolder.prototype = Object.create(CheerpJFolder.prototype);

function idbTrap(e)
{
debugger
}

function idbStatAsync(mp, path, fileRef, cb)
{
	idbEnsureDBConnection(mp, function()
	{
	// We get here after dbConnection is valid
	assert(path[path.length-1]!='/');
	var tx = mp.dbConnection.transaction("files", "readonly");
	var store = tx.objectStore("files");
	// Find the directory
	var req = store.get(path);
	assert(req.readyState != "done");
	req.fileRef = fileRef;
	req.onerror = idbTrap;
	function gotRes(fileRef, res)
	{
		if(!res)
		{
			fileRef.permType = 0;
		}
		else
		{
			fileRef.inodeId = res.inodeId;
			if(res.hasOwnProperty("permType"))
				fileRef.permType = res.permType;
			else if(res.type == "dir")
				fileRef.permType = CheerpJFileData.S_IFDIR | 0777;
			else if(res.type == "s")
				fileRef.permType = CheerpJFileData.S_IFSOCK | 0666;
			else
			{
				assert(res.type == "file");
				fileRef.permType = CheerpJFileData.S_IFREG | 0666;
			}
			if(res.type == "file")
				fileRef.fileLength = res.contents == null ? 0 : res.contents.length;
			else if(res.type == "special")
				fileRef.contents = res.contents;
		}
		return cb();
	}
	req.onsuccess = function(e)
	{
		this.onerror = null;
		this.onsuccess = null;
		var res = this.result;
		if(typeof(res) == "number")
		{
			assert(store != null);
			var req = store.get(res);
			assert(req.readyState != "done");
			req.fileRef = this.fileRef;
			req.onerror = idbTrap;
			req.onsuccess = function(e)
			{
				this.onerror = null;
				this.onsuccess = null;
				var res = this.result;
				return gotRes(this.fileRef, res);
			};
			return;
		}
		return gotRes(this.fileRef, res);
	}
	});
}

function idbListAsync(mp,path, fileRef, cb)
{
	idbEnsureDBConnection(mp, function()
	{
	// We get here after dbConnection is valid
	assert(path[path.length-1]!='/');
	var tx = mp.dbConnection.transaction("files", "readonly");
	var store = tx.objectStore("files");
	// Find the directory
	var req = store.get(path);
	assert(req.readyState != "done");
	req.fileRef = fileRef;
	req.onerror = idbTrap;
	req.onsuccess = function(e)
	{
		this.onerror = null;
		this.onsuccess = null;
		var res = this.result;
		if(res && res.type == "dir")
		{
			var c = res.contents;
			for(var i=0;i<c.length;i++)
				fileRef.push(c[i].substr(1));
		}
		// If there is no event, this is an sync handling
		if(e){
			return cb();
		}
	}
	if(req.readyState == "done"){
		req.onsuccess(null);
		return cb();
	}else{
		return;
	}
	});
}

function idbCreateDirAsync(mp, path, fileRef, mode, cb)
{
	idbEnsureDBConnection(mp, function(){
	// We get here after dbConnection is valid
	assert(path[path.length-1]!='/');
	// Find where the parent directory ends
	var parentEnd = path.lastIndexOf('/');
	assert(parentEnd >= 0);
	var parentPath = path.substring(0, parentEnd);
	var tx = mp.dbConnection.transaction("files", "readwrite");
	var store = tx.objectStore("files");
	function gotParent(res, asyncThread)
	{
		if(!res)
			fileRef.exists = 0;
		else
			fileRef.exists = (res.type == "dir" ? 5 : 3);
		if(fileRef.exists !== 5)
		{
			// Parent directory does not exist or it's not a directory
			if(asyncThread)
			{
				fileRef.exists = 0;
				return asyncThread();
			}
			return;
		}
		// Add this new object to the parent Path
		var childPath = path.substring(parentPath.length);
		assert(childPath[0]=='/');
		for(var i=0;i<res.contents.length;i++)
		{
			if(res.contents[i] == childPath)
			{
				if(asyncThread)
				{
					fileRef.exists = 5;
					return asyncThread();
				}
				return;
			}
		}
		res.contents.push(childPath);
		idbAddDEntry(mp, parentPath, res);
		store.put(res, parentPath);
		var cachedDE = idbCheckDEntry(mp, "");
		var curInodeId = cachedDE.nextInode++;
		store.put(cachedDE, "");
		store.put({ type: "dir", contents:[], inodeId: curInodeId, permType: CheerpJFileData.S_IFDIR | (mode & 01777)}, path);
		if(asyncThread)
		{
			fileRef.exists = 5;
			return asyncThread();
		}
	}
	var cachedDE = idbCheckDEntry(mp, parentPath);
	if(cachedDE)
	{
		gotParent(cachedDE, null);
		return cb();
	}
	else
	{
		// Find the parent
		var req = store.get(parentPath);
		if(req.readyState == "done")
		{
			gotParent(req.result, null);
			return cb();
		}
		else
		{
			req.onerror = idbTrap;
			req.onsuccess = function(e) { this.onerror = null; this.onsuccess = null; gotParent(this.result, cb); }
			return;
		}
	}
	});
}

function idbCheckDEntry(mp, path)
{
	// Does it exists already?
	var ret = mp.dEntries[path];
	if(!ret){
		return null;
	}
	// Yep, mark it for LRU
	ret.ts = Date.now();
	return ret.res;
}

function idbAddDEntry(mp, path, res)
{
	if(idbCheckDEntry(mp, path)){
		return;
	}
	mp.dEntries[path] = { res: res, ts: Date.now() };
}

function idbDecRefIndirect(store, fileRef)
{
	fileRef.refCount = fileRef.refCount-1|0;
	if(fileRef.refCount == 0)
		store.delete(fileRef.inodeId);
	else
		store.put(fileRef, fileRef.inodeId);
}

function idbResolve(mp, path, fileRef, cb)
{
	var parentPath = null;
	// We get here after dbConnection is valid
	if(path.length == 0)
	{
		// Getting the root directory, special case this
		parentPath = path;
	}
	else
	{
		assert(path[path.length-1]!='/');
		// Find where the parent directory ends
		var parentEnd = path.lastIndexOf('/');
		assert(parentEnd >= 0);
		parentPath = path.substring(0, parentEnd);
	}
	function gotFile(parentRes, res, asyncThread, store)
	{
		if(typeof(res) == "number")
		{
			assert(store != null);
			assert(asyncThread != null);
			var req = store.get(res);
			assert(req.readyState != "done");
			req.onerror = idbTrap;
			req.onsuccess = function(e)
			{
				this.onerror = null;
				this.onsuccess = null;
				var res = this.result;
				gotFile(parentRes, res, asyncThread, store);
			}
			return;
		}
		fileRef.parentPath = parentPath;
		fileRef.parentRes = parentRes;
		fileRef.res = res;
		if(asyncThread)
		{
			return asyncThread();
		}
	}
	function gotParent(res, asyncThread, store)
	{
		var parentRes = res;
		if(!res || res.type != "dir")
		{
			// Parent directory does not exist or it's not a directory
			fileRef.fileData = null;
			if(asyncThread)
			{
				return asyncThread();
			}
			return false;
		}
		idbAddDEntry(mp, parentPath, res);
		// The file may already exists
		var filePath = path.substr(parentPath.length);
		var fileIndex = res.contents.indexOf(filePath);
		if(filePath == "")
		{
			gotFile(parentRes, parentRes, asyncThread, store);
			return false;
		}
		else if(fileIndex < 0)
		{
			gotFile(parentRes, null, asyncThread, store);
			return false;
		}
		else
		{
			if(store == null)
			{
				var tx = mp.dbConnection.transaction("files", "readonly");
				var store = tx.objectStore("files");
			}
			var req = store.get(path);
			assert(req.readyState != "done");
			req.onerror = idbTrap;
			req.onsuccess = function(e)
			{
				this.onerror = null;
				this.onsuccess = null;
				var res = this.result;
				gotFile(parentRes, res, asyncThread ? asyncThread : cb, store);
			}
			return true;
		}
	}
	var cachedDE = idbCheckDEntry(mp, parentPath);
	var doAsync = false;
	if(cachedDE)
	{
		doAsync = gotParent(cachedDE, null, null);
	}
	else
	{
		// Find the parent
		var tx = mp.dbConnection.transaction("files", "readonly");
		var store = tx.objectStore("files");
		var req = store.get(parentPath);
		assert(req.readyState != "done");
		if(req.readyState == "done")
			doAsync = gotParent(null, null, store);
		else
		{
			req.onerror = idbTrap;
			req.onsuccess = function(e) { this.onerror = null; this.onsuccess = null; gotParent(this.result, cb, this.source); }
			doAsync = true;
			assert(req.readyState != "done");
		}
	}
	if(doAsync)
	{
		return;
	}
	return cb();
}

function idbMakeFileData(mp, path, mode, cb)
{
	assert(mp.isSplit);
	var fileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbEnsureDBConnection(mp, function(){
	idbResolve(mp, path, fileRef, function(){
	var tx = mp.dbConnection.transaction("files", "readwrite");
	var store = tx.objectStore("files");
	if(fileRef.parentRes == null)
	{
		// Parent directory does not exists
		return cb(null);
	}
	else
	{
		var parentPath = fileRef.parentPath;
		var parentRes = fileRef.parentRes;
		var res = fileRef.res;
		var fileExists = res && (res.type == "file" || res.type == "dir");
		var fileIsIndirect = res && res.hasOwnProperty("refCount");
		if(mode == "r" || ((mode == "r+" || mode == "w") && fileExists))
		{
			if(fileExists)
			{
				if(res.type == "file")
				{
					var data = res.contents;
					var chunks = [];
					if(mode == "w")
						data = null;
					else if(data)
					{
						var cur = 0;
						var len = data.length;
						var chunkSize = 1024*1024;
						while(cur < len)
						{
							var thisChunkSize = (len - cur) < chunkSize ? len - cur : chunkSize;
							var c = new Uint8Array(chunkSize);
							c.set(data.subarray(cur, cur+thisChunkSize));
							chunks.push(c);
							cur += thisChunkSize;
						}
						assert(cur == len);
					}
					var permType = res.permType ? res.permType : CheerpJFileData.S_IFREG | 0666;
					if(mp.inodeCache[res.inodeId])
					{
						fileRef.fileData = mp.inodeCache[res.inodeId];
						fileRef.path = null;
					}
					else
					{
						fileRef.fileData = new CheerpJFileData(mp, fileIsIndirect ? null : path, data?data.length:0, res.inodeId, permType, /*lastModified*/0);
						fileRef.fileData.mount = mp.inodeOps;
						fileRef.fileData.chunks = chunks;
					}
					if(mode == "w")
						fileRef.fileData.dirty = 1;
				}
				else if(res.type == "dir")
				{
					// It is legal to get an fd to a directory
					var permType = res.permType ? res.permType : CheerpJFileData.S_IFDIR | 0777;
					// It not legal to have multiple names for the same directory
					assert(!mp.inodeCache[res.inodeId]);
					fileRef.fileData = new CheerpJFileData(mp, path, 0, res.inodeId, permType, /*lastModified*/0);
					fileRef.fileData.mount = mp.inodeOps;
				}
			}
			else
				fileRef.fileData = null;
		}
		else if(mode == "r+" || mode == "w")
		{
			// w is truncate, so we always update the file
			assert(!fileExists);
			{
				// Add this new object to the parent Path
				var childPath = path.substring(parentPath.length);
				assert(childPath[0]=='/');
				assert(parentRes.contents);
				parentRes.contents.push(childPath);
				store.put(parentRes, parentPath);
			}
			// TODO: Check if the file is actually a dir
			var cachedDE = idbCheckDEntry(mp, "");
			var curInodeId = cachedDE.nextInode++;
			store.put(cachedDE, "");
			store.put({ type: "file", contents:null, inodeId: curInodeId }, path);
			fileRef.fileData = new CheerpJFileData(mp, path, 0, curInodeId, CheerpJFileData.S_IFREG | 0666, /*lastModified*/0);
			fileRef.fileData.dirty = 1;
			fileRef.fileData.mount = mp.inodeOps;
			fileRef.fileData.chunks = [];
		}
		else if(mode == "s")
		{
			if(fileExists)
				fileRef.fileData = null;
			else
			{
				// Add this new object to the parent Path
				var childPath = path.substring(parentPath.length);
				assert(childPath[0]=='/');
				assert(parentRes.contents);
				parentRes.contents.push(childPath);
				store.put(parentRes, parentPath);
				var cachedDE = idbCheckDEntry(mp, "");
				var curInodeId = cachedDE.nextInode++;
				store.put(cachedDE, "");
				store.put({ type: "special", contents:null, inodeId: curInodeId }, path);
				fileRef.fileData = new CheerpJFileData(mp, path, 0, curInodeId, CheerpJFileData.S_IFSOCK | 0666, /*lastModified*/0);
				fileRef.fileData.dirty = 1;
				fileRef.fileData.mount = mp.inodeOps;
			}
		}
		else
			debugger
	}
	// The returned value may be null if the file can't be created
	return cb(fileRef.fileData);
	});
	});
}

function idbRenameAsync(mp, srcPath, dstPath, cb)
{
	idbEnsureDBConnection(mp, function(){
	// The whole operation should be atomic, using a single transaction should do it
	// TODO: What about the file cache atomicity? That is handled in the caller.
	var srcFileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbResolve(mp, srcPath, srcFileRef, function(){
	if(srcFileRef.res == null){
		// File does not exists
		return cb(0);
	}
	var dstFileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbResolve(mp, dstPath, dstFileRef, function()
	{
	assert(dstFileRef.res == null || !dstFileRef.res.hasOwnProperty("refCount"));
	if(dstFileRef.parentRes == null){
		// Parent directory does not exists
		return cb(0);
	}
	// TODO: Support renaming directories
	if(srcFileRef.res.type == "dir"){
		return cb(0);
	}
	var tx = mp.dbConnection.transaction("files", "readwrite");
	var store = tx.objectStore("files");
	// 1) Remove src file from parent directory
	var srcChildPath = srcPath.substr(srcFileRef.parentPath.length);
	var srcParentIndex = srcFileRef.parentRes.contents.indexOf(srcChildPath);
	assert(srcParentIndex >= 0);
	srcFileRef.parentRes.contents.splice(srcParentIndex, 1);
	store.put(srcFileRef.parentRes, srcFileRef.parentPath);
	// 2) Remove src from the DB
	store.delete(srcPath);
	// 3) Add the file to the dst directory
	var dstChildPath = dstPath.substr(dstFileRef.parentPath.length);
	var dstParentIndex = dstFileRef.parentRes.contents.indexOf(dstChildPath);
	if(dstParentIndex < 0){
		dstFileRef.parentRes.contents.push(dstChildPath);
		store.put(dstFileRef.parentRes, dstFileRef.parentPath);
	}
	// 4) Store the contents to the dst path
	store.put(srcFileRef.res, dstPath);
	tx.oncomplete = function(e){
		return cb(1);
	}
	});
	});
	});
}

function idbLinkAsync(mp, srcPath, dstPath, cb)
{
	idbEnsureDBConnection(mp, function(){
	// The whole operation should be atomic, using a single transaction should do it
	var srcFileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbResolve(mp, srcPath, srcFileRef, function(){
	if(srcFileRef.res == null){
		// File does not exists
		return cb(0);
	}
	var dstFileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbResolve(mp, dstPath, dstFileRef, function()
	{
	if(dstFileRef.res != null){
		// Dest file already exists
		return cb(0);
	}
	if(dstFileRef.parentRes == null){
		// Parent directory does not exists
		return cb(0);
	}
	// Hard-linking directories is not supported
	if(srcFileRef.res.type == "dir"){
		return cb(0);
	}
	var tx = mp.dbConnection.transaction("files", "readwrite");
	var store = tx.objectStore("files");
	// 1) Check if srcFileRef needs to become indirect
	if(!srcFileRef.res.hasOwnProperty("refCount")){
		var res = srcFileRef.res;
		var inodeId = res.inodeId;
		assert(inodeId);
		store.put(inodeId, srcPath);
		res.refCount = 1;
		var cachedFileData = mp.inodeCache[inodeId];
		if(cachedFileData){
			assert(cachedFileData.path);
			cachedFileData.path = null;
		}
	}
	// 2) Add the file to the dst directory
	var dstChildPath = dstPath.substr(dstFileRef.parentPath.length);
	var dstParentIndex = dstFileRef.parentRes.contents.indexOf(dstChildPath);
	assert(dstParentIndex < 0);
	dstFileRef.parentRes.contents.push(dstChildPath);
	store.put(dstFileRef.parentRes, dstFileRef.parentPath);
	// 3) Store the contents to the dst path, as indirect
	srcFileRef.res.refCount = srcFileRef.res.refCount+1|0;
	store.put(srcFileRef.res, srcFileRef.res.inodeId);
	store.put(srcFileRef.res.inodeId, dstPath);
	tx.oncomplete = function(e){
		return cb(1);
	}
	});
	});
	});
}

function idbReadAsync(fileData, fileOffset, buf, off, len, flags, cb)
{
	var chunkSize = 1024*1024;
	var curChunk = fileOffset / chunkSize | 0;
	if(fileOffset + len > fileData.length)
		len = fileData.length - fileOffset;
	if(len<=0){
		return cb(0);
	}
	var endChunk = (fileOffset + len) / chunkSize | 0;
	var fileRef={cheerpjDownload:null};
	while(len && curChunk <= endChunk){
		assert(fileData.chunks[curChunk]);
		var curChunk = curChunk+1|0;
	}
	// All chunks are now loaded
	var curChunk = fileOffset / chunkSize | 0;
	var curOffset = fileOffset - (curChunk*chunkSize) | 0;
	var i=0;
	while(i<len)
	{
		var c = fileData.chunks[curChunk];
		if((len-i) < (chunkSize-curOffset))
			chunkSize = curOffset+(len-i);
		for(var j=curOffset;j<chunkSize;j++)
		{
			buf[off+i|0]=c[j];
			i++;
		}
		curChunk++;
		curOffset=0;
	}
	assert(i==len);
	return cb(len);
}

function idbWriteAsync(fileData, fileOffset, buf, off, len, cb)
{
	var chunkSize = 1024*1024;
	var curChunk = 0;
	var endChunk = (fileOffset + len) / chunkSize | 0;
	// Create all chunks first
	while(curChunk <= endChunk)
	{
		if(fileData.chunks[curChunk])
		{
			var curChunk = curChunk+1|0;
			continue;
		}
		fileData.chunks[curChunk]=new Uint8Array(chunkSize);
		curChunk = curChunk+1|0;
	}
	var curChunk = fileOffset / chunkSize | 0;
	var curOffset = fileOffset - (curChunk*chunkSize) | 0;
	var i=0;
	while(i<len)
	{
		var c = fileData.chunks[curChunk];
		if((len-i) < (chunkSize-curOffset))
			chunkSize = curOffset+(len-i);
		for(var j=curOffset;j<chunkSize;j++)
		{
			c[j]=buf[off+i|0];
			i++;
		}
		curChunk++;
		curOffset=0;
	}
	assert(i==len);
	if((fileOffset+len|0) > fileData.length)
	{
		fileData.length = fileOffset + len | 0;
	}
	return cb(len);
}

function idbCommitFileData(fileData)
{
	var mp = fileData.parent;
	assert(mp.isSplit);
	assert(fileData.dirty);
	assert(mp.dbConnection);
	var fileRef = null;
	var filePath = fileData.path;
	if(filePath == null){
		assert(fileData.inodeId > 0);
		filePath = fileData.inodeId;
	}
	// For non-files we only update permType
	if((fileData.permType & CheerpJFileData.S_IFMT) != CheerpJFileData.S_IFREG){
		fileRef={};
		idbResolve(mp, filePath, fileRef, function()
		{
			assert(fileRef.res);
			fileRef = fileRef.res;
			fileRef.permType = fileData.permType;
			if((fileData.permType & CheerpJFileData.S_IFMT) != CheerpJFileData.S_IFDIR){
				fileRef.contents = fileData.chunks;
			}
			var tx = mp.dbConnection.transaction("files", "readwrite");
			var store = tx.objectStore("files");
			fileData.dirty = 0;
			store.put(fileRef, filePath);
		});
	}else{
		var contents = new Uint8Array(fileData.length);
		var chunkSize = 1024*1024;
		var curChunk = 0;
		for(var i=0;i<fileData.length;)
		{
			var c = fileData.chunks[curChunk];
			if(fileData.length - i < chunkSize)
				c = c.subarray(0, fileData.length-i)
			contents.set(c, i);
			curChunk++;
			i += c.length;
		}
		fileRef = { type: "file", contents:contents, inodeId: fileData.inodeId, permType: fileData.permType };
		var tx = mp.dbConnection.transaction("files", "readwrite");
		var store = tx.objectStore("files");
		fileData.dirty = 0;
		store.put(fileRef, filePath);
	}
}

function idbUnlinkAsync(mp, path, cb)
{
	assert(mp.isSplit);
	var fileRef={fileData:null, parentPath: null, parentRes:null, res:null};
	idbEnsureDBConnection(mp, function(){
	idbResolve(mp, path, fileRef, function(){
	if(fileRef.res == null)
	{
		// File does not exists
		return cb(false);
	}
	else
	{
		var parentPath = fileRef.parentPath;
		var parentRes = fileRef.parentRes;
		var res = fileRef.res;
		if(res.type == "dir")
		{
			// We can only delete empty directories
			if(res.contents.length > 0)
				return cb(false);
		}
		var filePath = path.substr(parentPath.length);
		var fileIndex = parentRes.contents.indexOf(filePath);
		assert(filePath.length > 0);
		assert(fileIndex >= 0);
		parentRes.contents.splice(fileIndex, 1);
		var tx = mp.dbConnection.transaction("files", "readwrite");
		var store = tx.objectStore("files");
		tx.onerror = idbTrap;
		tx.onabort = idbTrap;
		tx.oncomplete = function()
		{
			this.onerror = null;
			this.onabort = null;
			this.oncomplete = null;
			// If we get here the deletion was successfull
			return cb(true);
		};
		store.put(parentRes, parentPath);
		store.delete(path);
		if(fileRef.res.hasOwnProperty("refCount"))
			idbDecRefIndirect(store, fileRef.res);
	}
	});
	});
}

function idbEnsureDBConnection(mp, cb)
{
	if(mp.dbConnection == null){
		// Async connection to the DB
		var openResult = indexedDB.open("cjFS_"+mp.mountPoint);
		assert(openResult.readyState != "done");
		openResult.folder = mp;
		openResult.onerror = idbTrap;
		openResult.onsuccess = function(e)
		{
			this.onerror = null;
			this.onsuccess = null;
			this.onupgradeneeded = null;
			this.folder.dbConnection = this.result;
			var tx = this.folder.dbConnection.transaction("files", "readonly");
			// Retrieve the first unallocated inode
			var store = tx.objectStore("files");
			var inodeReq = store.get("");
			assert(inodeReq.readyState != "done");
			inodeReq.folder = this.folder;
			inodeReq.onerror = idbTrap;
			inodeReq.onsuccess = function()
			{
				idbAddDEntry(this.folder, "", this.result);
				this.folder.inodeId = this.result.nextInode;
				return cb();
			};
		}
		openResult.onupgradeneeded = function(e)
		{
			this.onerror = null;
			this.onsuccess = null;
			this.onupgradeneeded = null;
			var db = this.result;
			db.onerror = idbTrap;
			db.onabort = idbTrap;
			db.onclose = idbTrap;
			db.onversionchange = idbTrap;
			var store=db.createObjectStore("files");
			// Initialize the root dir
			var req = store.add({ type: "dir", contents:[], inodeId: 1, nextInode:2 }, "");
			assert(req.readyState != "done");
			// TODO: What if this fails?
			req.onabort = idbTrap;
			this.transaction.oncomplete = function()
			{
				this.oncomplete = null;
				openResult.folder.dbConnection = this.db;
				return cb();
			}
		}
	}else{
		return cb();
	}
}

var IdbOps = { statAsync: idbStatAsync, listAsync: idbListAsync, makeFileData: idbMakeFileData, createDirAsync: idbCreateDirAsync, renameAsync: idbRenameAsync, linkAsync: idbLinkAsync, unlinkAsync: idbUnlinkAsync };
var IdbInodeOps = { readAsync: idbReadAsync, writeAsync: idbWriteAsync, commitFileData: idbCommitFileData };

function CheerpJDataFolder(mp)
{
	CheerpJFolder.call(this, mp);
	this.mountOps = StrOps;
	this.inodeOps = StrInodeOps;
	this.files = {};
	this.lastInode = 1;
}

CheerpJDataFolder.prototype = Object.create(CheerpJFolder.prototype);

function strStatAsync(mp, path, fileRef, cb)
{
	if(path == "")
	{
		fileRef.permType = CheerpJFileData.S_IFDIR | 0555;
		// Use the dev id as the inode id
		fileRef.inodeId = mp.devId;
		return cb();
	}
	if(mp.files.hasOwnProperty(path))
	{
		var file = mp.files[path];
		fileRef.fileLength = file.data.length;
		fileRef.permType = CheerpJFileData.S_IFREG | 0444;
		fileRef.inodeId = file.inodeId;
	}
	else
	{
		fileRef.permType = 0;
	}
	return cb();
}

function strListAsync(mp, path, fileRef, cb)
{
	// Only the root itself can be listed
	if(path != ""){
		return cb();
	}
	for(var p in mp.files)
	{
		fileRef.push(p.substring(1));
	}
	return cb();
}

function strMakeFileData(mp, path, mode, cb)
{
	assert(mp.files.hasOwnProperty(path));
	var str = mp.files[path].data;
	if(str instanceof Uint8Array){
		var ret = str;
	}else{
		var ret = new Uint8Array(str.length);
		for(var i=0;i<str.length;i++)
			ret[i] = str.charCodeAt(i);
	}
	var inodeId = mp.files[path].inodeId
	var fileData = new CheerpJFileData(mp, path, ret.length|0, inodeId|0, CheerpJFileData.S_IFREG | 0444, /*lastModified*/0);
	fileData.mount = mp.inodeOps;
	fileData.data = ret;
	return cb(fileData);
}

function strReadAsync(fileData, fileOffset, buf, off, len, flags, cb)
{
	if(len > fileData.data.length - fileOffset)
		len = fileData.data.length - fileOffset;
	// EOF
	if(len == 0){
		return cb(0);
	}
	for(var i=0;i<len;i++)
		buf[off+i|0] = fileData.data[fileOffset+i|0];
	return cb(len);
}

var StrOps = { statAsync: strStatAsync, listAsync: strListAsync, makeFileData: strMakeFileData, createDirAsync: null, renameAsync: null, linkAsync: null, unlinkAsync: null };
var StrInodeOps = { readAsync: strReadAsync, writeAsync: null, commitFileData: null };

function CheerpJDevFolder(mp, basePath)
{
	CheerpJFolder.call(this, mp);
	this.mountOps = DevOps;
	this.inodeOps = null;
	this.isSplit = true;
	this.devMap = {};
	// Reserve inode 1 for random/urandom
	this.nextInode = 2;
}

CheerpJDevFolder.prototype = Object.create(CheerpJFolder.prototype);

function devStatAsync(mp, path, fileRef, cb)
{
	if(path == "/random" || path == "/urandom")
	{
		fileRef.permType = CheerpJFileData.S_IFCHR | 0666;
	}
	else
	{
		fileRef.permType = 0;
	}
	return cb();
}

function devMakeFileData(mp, path, mode, cb)
{
	var fileData = null;
	if(path == "/random" || path == "/urandom")
	{
		fileData = new CheerpJFileData(mp, path, 0xffffffff, 1, CheerpJFileData.S_IFCHR | 0666, /*lastModified*/0);
		fileData.mount = DevRandomInodeOps;
	}
	else if(mp.devMap.hasOwnProperty(path))
	{
		fileData = new CheerpJFileData(mp, path, 0xffffffff, mp.devMap[path].inodeId, CheerpJFileData.S_IFCHR | 0666, /*lastModified*/0);
		fileData.mount = mp.devMap[path];
	}
	return cb(fileData);
}

function devRandomRead(fileData, fileOffset, buf, off, len, flags, cb)
{
	// TODO: This is very unsafe! Math.random() is not ok for true randomness
	for(var i=0;i<len;i++)
		buf[off+i|0] = Math.random()*0x100;
	return cb(len);
}

function devRandomWrite(fileData, fileOffset, buf, off, len, flags, cb)
{
	return cb(len);
}

var DevRandomInodeOps = { readAsync: devRandomRead, writeAsync: devRandomWrite, commitFileData: null };

var DevOps = { statAsync: devStatAsync, listAsync: null, makeFileData: devMakeFileData, createDirAsync: null, renameAsync: null, linkAsync: null, unlinkAsync: null };

function conReadAsync(fileData, fileOffset, buf, off, len, flags, cb)
{
	fileData.inCallback(fileData.param, fileOffset, buf, off, len, cb);
}

function conWriteAsync(fileData, fileOffset, buf, off, len, cb)
{
	fileData.outCallback(fileData.param, fileOffset, buf, off, len, cb);
}

var ConInodeOps = { readAsync: conReadAsync, writeAsync: conWriteAsync, commitFileData: null };

function cheerpjCreateConsole(param, inCallback, outCallback)
{
	var fileData = new CheerpJFileData(null, null, 0, 0, CheerpJFileData.S_IFCHR | 0666, /*lastModified*/0);
	fileData.mount = ConInodeOps;
	// Add custom fields
	fileData.inCallback = inCallback;
	fileData.outCallback = outCallback;
	fileData.param = param;
	return fileData;
}

function cheerpjDefaultConsoleWrite(param, fileOffset, buf, off, len, cb)
{
	// Console output, either to debug console or DOM console
	var strBytes = ""
	for(var i=0;i<len;i++)
	{
		var b = buf[i+off]&0xff;
		var h = b.toString(16);
		if(b < 16)
			h = "0" + h;
		strBytes += "%" + h;
	}
	strBytes = decodeURIComponent(strBytes);
	var c = self.document ? document.getElementById("console") : null;
	if(c)
		c.textContent += strBytes;
	else
		console.log(strBytes);
	return cb(len);
}

function cheerpjAddStringFile(name, str)
{
	var mount = cheerpjGetFSMountForPath(name);
	assert(mount instanceof CheerpJDataFolder);
	var fileName = name.substr(mount.mountPoint.length-1);
	mount.files[fileName] = {inodeId:mount.lastInode, data:str};
	mount.lastInode = mount.lastInode + 1|0;
	mount.clearCached(fileName);
}

function cheerpjRemoveStringFile(name)
{
	var mount = cheerpjGetFSMountForPath(name);
	assert(mount instanceof CheerpJDataFolder);
	var fileName = name.substr(mount.mountPoint.length-1);
	delete mount.files[fileName];
	mount.clearCached(fileName);
}

function cheerpjGetFSMountForPath(path)
{
	for(var i=0;i<cheerpjFSMounts.length;i++)
	{
		var mount = cheerpjFSMounts[i];
		if(path.startsWith(mount.mountPoint)){
			return mount;
		}
	}
	debugger
	return null;
}

function cheerpjNormalizePath(path)
{
	var parts = path.split('/');
	var newParts = []
	var partsUnderflow = 0;
	for(var i=0;i<parts.length;i++)
	{
		if(parts[i] == '.' || parts[i] == "")
			continue;
		else if(parts[i] == '..')
		{
			if(newParts.length)
				newParts.pop();
			else
				partsUnderflow++;
		}
		else
			newParts.push(parts[i]);
	}
	if(!path.startsWith('/') && partsUnderflow == 0)
	{
		// TODO: Support cwd
		newParts.unshift("files");
	}
	return "/" + newParts.join("/");
}

function cheerpOSStat(path_, fileRef, cb)
{
	var path = cheerpjNormalizePath(path_)
	var mount = cheerpjGetFSMountForPath(path + "/");
	fileRef.parent = mount;
	mount.mountOps.statAsync(mount, path.substr(mount.mountPoint.length-1), fileRef, cb);
}

function cheerpjStatFileAsync(path_, fileRef, p)
{
	var isSync = true;
	var thread = currentThread;
	cheerpOSStat(path_, fileRef, function(){
		if(isSync){
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, 0);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
}

function cheerpOSListFiles(path_, fileRef, cb)
{
	var path = cheerpjNormalizePath(path_)
	var mount = cheerpjGetFSMountForPath(path + "/");
	// Some backends (like Web) do not implement list
	if(!mount.mountOps.listAsync){
		return;
	}
	mount.mountOps.listAsync(mount, path.substr(mount.mountPoint.length-1), fileRef, cb);
}

function cheerpjListFilesAsync(path_, fileRef, p)
{
	var isSync = true;
	var thread = currentThread;
	cheerpOSListFiles(path_, fileRef, function(){
		if(isSync){
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, 0);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
}

function cheerpOSCreateDir(path_, fileRef, mode, cb)
{
	var path = cheerpjNormalizePath(path_)
	var mount = cheerpjGetFSMountForPath(path);
	if(!mount.mountOps.createDirAsync){
		return;
	}
	mount.mountOps.createDirAsync(mount, path.substr(mount.mountPoint.length-1), fileRef, mode, cb);
}

function cheerpjCreateDirAsync(path_, fileRef, mode, p)
{
	var isSync = true;
	var thread = currentThread;
	cheerpOSCreateDir(path_, fileRef, mode, function(){
		if(isSync){
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, 0);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
}

// {fileData:<cacheEntry>, offset: 0, flags: 0}
var cjFDs = [undefined,undefined,undefined];

function cheerpOSAllocateFd(fds, fileData)
{
	var newFD = {fileData: fileData, offset: 0, flags: 0};
	for(var i=0;i<fds.length;i++)
	{
		if(fds[i]===null)
		{
			fds[i] = newFD;
			return i;
		}
	}
	fds.push(newFD);
	return fds.length-1|0;
}

function cheerpjWakeOpenThreads (fileName, mount)
{
	var tmp = mount.cacheThreads[fileName];
	delete mount.cacheThreads[fileName];
	for(var i = 0; i < tmp.length; i++)
	{
		tmp[i]();
	}
}

function cheerpOSOpen(fds, path_, mode, cb)
{
	var path = cheerpjNormalizePath(path_)
	var mount = cheerpjGetFSMountForPath(path + "/");
	var fileName = path.substr(mount.mountPoint.length-1);
	if(mount.cacheThreads[fileName]){
debugger;
		mount.cacheThreads[fileName].push(function()
		{
			cheerpOSOpenMain(fileName, mount, fds, mode, cb);
		});
		return;
	}
	return cheerpOSOpenMain(fileName, mount, fds, mode, cb);
}

function cheerpOSOpenMain(fileName, mount, fds, mode, cb)
{
	var fileData = mount.getCached(fileName);
	if(fileData === null)
	{
		mount.cacheThreads[fileName] = [];
		var fileRef = {};
		assert(mount.mountOps.makeFileData);
		mount.mountOps.makeFileData(mount, fileName, mode, function(fileData){
			if(fileData == null){
				cheerpjWakeOpenThreads(fileName, mount);
				return cb(-1);
			}
			mount.setCached(fileName, fileData);
			cheerpjWakeOpenThreads(fileName, mount);
			fileData.refCount=fileData.refCount+1|0;
			return cb(cheerpOSAllocateFd(fds, fileData));
		});
		return;
	}else if(mode != "r" && !fileData.parent.isSplit){
		// Make sure we don't allow opening for write a cached file that does not support it
		return cb(-1);
	}else if(mode == "w"){
		// Truncation of a cached file
		fileData.dirty = 1;
		fileData.chunks = [];
		fileData.length = 0;
	}
	fileData.refCount=fileData.refCount+1|0;
	return cb(cheerpOSAllocateFd(fds, fileData));
}

function cheerpjOpenAsync(fds, path_, mode, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSOpen(fds, path_, mode, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

function cheerpOSRead(fds, fd, buf, off, len, cb)
{
	if(fd < 0){
		return cb(-1);
	}
	var fdObj = fds[fd];
	assert(fdObj);
	assert(fdObj.fileData.mount);
	assert(off + len <= buf.length);
	fdObj.fileData.mount.readAsync(fdObj.fileData, fdObj.offset, buf, off, len, fdObj.flags, function(ret){
		if(ret<=0){
			return cb(ret);
		}
		fdObj.offset = fdObj.offset + ret|0;
		return cb(ret);
	});
}

function cheerpjReadAsync(fds, fd, buf, off, len, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSRead(fds, fd, buf, off, len, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

function cheerpOSWrite(fds, fd, buf, off, len, cb)
{
	if(fd < 0){
		return cb(-1);
	}
	var fdObj = fds[fd];
	assert(fdObj);
	assert(fdObj.fileData.mount);
	assert(off + len <= buf.length);
	fdObj.fileData.dirty = 1;
	fdObj.fileData.mount.writeAsync(fdObj.fileData, fdObj.offset, buf, off, len, function(ret){
		if(ret<=0){
			return cb(ret);
		}
		fdObj.offset = fdObj.offset + ret|0;
		return cb(ret);
	});
}

function cheerpjWriteAsync(fds, fd, buf, off, len, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSWrite(fds, fd, buf, off, len, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

function cheerpOSRename(srcPath_, dstPath_, cb)
{
	var srcPath = cheerpjNormalizePath(srcPath_);
	var dstPath = cheerpjNormalizePath(dstPath_);
	var srcMount = cheerpjGetFSMountForPath(srcPath + "/");
	var dstMount = cheerpjGetFSMountForPath(dstPath + "/");
	// Only allowed on the same mount point
	if(srcMount !== dstMount){
		return cb(0);
	}
	if(!srcMount.mountOps.renameAsync){
		return cb(0);
	}
	var prefixLen = srcMount.mountPoint.length-1;
	var srcFileName = srcPath.substr(prefixLen);
	var dstFileName = dstPath.substr(prefixLen);
	srcMount.mountOps.renameAsync(srcMount, srcFileName, dstFileName, function(ret){
		if(ret == 0){
			return cb(0);
		}
		srcMount.clearCached(srcFileName);
		srcMount.clearCached(dstFileName);
		return cb(1);
	});
}

function cheerpOSRenameAsync(srcPath_, dstPath_, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSRename(srcPath_, dstPath_, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

function cheerpOSLink(srcPath_, dstPath_, cb)
{
	var srcPath = cheerpjNormalizePath(srcPath_);
	var dstPath = cheerpjNormalizePath(dstPath_);
	var srcMount = cheerpjGetFSMountForPath(srcPath + "/");
	var dstMount = cheerpjGetFSMountForPath(dstPath + "/");
	// Only allowed on the same mount point
	if(srcMount !== dstMount){
		return cb(0);
	}
	if(!srcMount.mountOps.linkAsync){
		return cb(0);
	}
	var prefixLen = srcMount.mountPoint.length-1;
	srcMount.mountOps.linkAsync(srcMount, srcPath.substr(prefixLen), dstPath.substr(prefixLen), cb);
}

function cheerpOSLinkAsync(srcPath_, dstPath_, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSLink(srcPath_, dstPath_, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

function cheerpOSUnlink(path_, cb)
{
	var path = cheerpjNormalizePath(path_, false);
	var mount = cheerpjGetFSMountForPath(path);
	var fileName = path.substr(mount.mountPoint.length-1);
	mount.clearCached(fileName);
	if(!mount.mountOps.unlinkAsync)
		return cb(-1);
	mount.mountOps.unlinkAsync(mount, fileName, cb);
}

function cheerpOSUnlinkAsync(path_, p)
{
	var isSync = true;
	var ret = 0;
	var thread = currentThread;
	cheerpOSUnlink(path_, function(r){
		if(isSync){
			ret = r;
			isSync = false;
			return;
		}
		cheerpjWakeThreadWithValue(thread, r);
	});
	if(isSync){
		isSync = false;
		cheerpjPauseThread(p);
	}
	return ret;
}

var cjGraceTimeQueue = []

function cjGraceTimeExpire()
{
	// Only get the first item on the queue
	assert(cjGraceTimeQueue.length);
	var fileData = cjGraceTimeQueue.shift();
	if(fileData == null)
	{
		// The file lifetime has been bumped
		return;
	}
	if(fileData.refCount > 0)
	{
		// The file has been resurrected
		return;
	}
	// File dead, free the memory
	var mount = fileData.parent;
	for(var f in mount.fileCache)
	{
		if(fileData.inodeId == mount.fileCache[f])
			mount.clearCached(f);
	}
	assert(fileData.cacheRefCount == 0);
}

function cheerpOSClose(fds, fd)
{
	if(fd==-1){
		return;
	}
	var fdObj = fds[fd];
	assert(fdObj);
	var fileData = fdObj.fileData;
	// No fileData may be there for FDs which are not files
	if(fileData)
	{
		fileData.refCount = fileData.refCount-1|0;
		if(fileData.refCount===0 && fileData.parent != null)
		{
			if(fileData.dirty)
			{
				for(var p in cosFileWatchPrefixes)
				{
					assert(fileData.path.startsWith("/"));
					var path = fileData.parent.mountPoint + fileData.path.substr(1);
					if(path === p || path.startsWith(p + "/"))
						cosFileWatchPrefixes[p](path);
				}
				// Commit the data immediately to ensure persistence
				if(fileData.mount.commitFileData)
					fileData.mount.commitFileData(fileData);
			}
			// Make sure there is only one entry in the queue for each file,
			// if there is an existing one, null it out
			var prevIdx = cjGraceTimeQueue.indexOf(fileData);
			if(prevIdx >= 0)
				cjGraceTimeQueue[prevIdx] = null;
			// Put the cached file in the queue, and give it a 10 sec grace time before freeing the memory
			cjGraceTimeQueue.push(fileData);
			setTimeout(cjGraceTimeExpire, 10000);
		}
	}
	fds[fd] = null;
}

function cheerpjCloseAsync(fds, fd, p)
{
	return cheerpOSClose(fds, fd);
}

function socketReadAsync(fileData, fileOffset, buf, off, len, flags, cb)
{
	assert(len != 0);
	let cnt = off;
	
	if(fileData.currData === null){
		return cb(0);
	}
	return socketReadLoop(fileData, fileOffset, buf, off, len, flags, cnt, cb);
}

function socketReadLoop(fileData, fileOffset, buf, off, len, flags, cnt, cb)
{
	while(1){
		if(cnt === off+len){
			break;
		}
		if(!fileData.currData || fileData.currPos >= fileData.currData.length){
			while(1){
				if(fileData.chunks.length !== 0){
					break;
				}
				fileData.blockedThread = function(){
					return socketReadLoop(fileData, fileOffset, buf, off, len, flags, cnt, cb);
				};
				return;
			}
			fileData.currData = fileData.chunks.shift();
			fileData.currPos = 0;
			if(!(fileData.currData instanceof Uint8Array)){
				if(fileData.currData == 'cjRemoteError')
				{
					fileData.currData = null;
					return cb(cnt-off);
				}
				else 
				{
					return cb(cnt-off);
				}
			}
		}

		buf[cnt] = fileData.currData[fileData.currPos];
		fileData.currPos = fileData.currPos + 1 | 0;
		cnt++;
	}
	return cb(cnt-off);
}

function cheerpNetReadFetchOS(reader,fileData)
{
	reader.read()
		.then(function(result){
			if(result.done)
			{
				fileData.chunks.push(null);
			}
			else
			{
				if(result.value instanceof ArrayBuffer)
				{
					fileData.chunks.push(new Uint8Array(result.value));
				}
				else
				{
					fileData.chunks.push(result.value);
				}
			}
			if(fileData.blockedThread)
			{
				var blockedThread=fileData.blockedThread;
				fileData.blockedThread=null;
				return blockedThread();
			}
			if(!result.done)
			{
				cheerpNetReadFetchOS(reader, fileData);
			}
		});
}

function httpSocketWriteAsync(fileData, fileOffset, buf, off, len, cb)
{
	let i = 0;
	let cnt = 0;
	if(fileData.currRequest.headersNewLines < 1)
	{
		/*Consume bytes*/
		for(i = off; i < off+len && fileData.currRequest.headersNewLines < 1; i++)
		{
			cnt++;
			let currChar = String.fromCharCode(buf[i]);
			if(currChar === '\n'){ /* Parse */
				let line = fileData.currRequest.currString;
				if(line.startsWith('\r'))
				{
					fileData.currRequest.headersNewLines++;
				}
				else 
				{
					if(fileData.currRequest.nLines === 0 && line.indexOf("HTTP/1.1") !== -1)
					{
						let firstLine = line.split(" ");
						fileData.currRequest.method = firstLine[0];
						fileData.currRequest.url = firstLine[1];
					}
					else if(!line.toLowerCase().startsWith("cookie")) 
					{
						let key = line.substr(0,line.indexOf(':'));
						let value = line.substr(line.indexOf(':')+2);
						if(key.toLowerCase() === "host")
						{
							if(window.location.protocol == "https:")
							{
								fileData.currRequest.url = "https://" + value + fileData.currRequest.url;
							}
							else 
							{
								fileData.currRequest.url = "http://" + value + fileData.currRequest.url;
							}
						}
						else
						{
							fileData.currRequest.headers.append(key, value);
						}
					}
				}
				fileData.currRequest.currString = "";
				fileData.currRequest.nLines++;
			}else
			{
				fileData.currRequest.currString += currChar;
			}
			fileData.currRequest.prevChar = currChar;
		}
		off = off + i - 1;
	}
	if(fileData.currRequest.headersNewLines >= 1)
	{
		if(fileData.currRequest.method === "POST")
		{
			if(!fileData.currRequest.data)
			{
				fileData.currRequest.data = new Uint8Array(parseInt(fileData.currRequest.headers.get("Content-Length")));
			}
			fileData.currRequest.data.set(buf.subarray(off, len), fileData.currRequest.dataIdx);
			fileData.currRequest.dataIdx += len-off+1;
			cnt += len-off;
		}
		if((fileData.currRequest.method === "POST" && fileData.currRequest.dataIdx < fileData.currRequest.headers.get("Content-Length"))
			|| (fileData.currRequest.method !== "POST" && fileData.currRequest.headersNewLines < 1))
		{
			return cb(cnt);
		}
		let dict = {credential: 'include', method: fileData.currRequest.method, headers: fileData.currRequest.headers};
		if(fileData.currRequest.data)
		{
			dict.body = fileData.currRequest.data;
		}
		fetch(fileData.currRequest.url, dict)
			.then(function(response)
				{
					let cjStr2AB = function(str) {
						let bufView = new Uint8Array(str.length);
						for (var i=0; i < str.length; i++) {
							bufView[i] = str.charCodeAt(i);
						}
						return bufView;
					};
					if(response.ok)
					{
						let responseStatus = "HTTP/1.1 " + response.status + " " + response.statusText;
						let responseHeaders = response.headers.entries();
						fileData.chunks.push(cjStr2AB(responseStatus+'\r\n'));

						let entry = responseHeaders.next();
						while (!entry.done)
						{
							if(entry.value[0].toLowerCase() === "transfer-encoding")
							{
								entry = responseHeaders.next();
								continue;
							}
							let he = entry.value[0] + ': ' + entry.value[1] + '\r\n';
							fileData.chunks.push(cjStr2AB(he));
							entry = responseHeaders.next();
						}
						fileData.chunks.push(cjStr2AB("\r\n"));

						const reader = response.body.getReader();
						cheerpNetReadFetchOS(reader, fileData);
					}else
					{
						fileData.chunks.push('cjRemoteError');
					}
				})
			.catch(function(err)
				{
					fileData.chunks.push('cjRemoteError');
				});
	}
	else if(fileData.currRequest.currString.length >= 4)
	{
		// Not even 1 line available, can this even be HTTP?
		if(!fileData.currRequest.currString.startsWith("HTTP")) {
			fileData.chunks.push('cjRemoteError');
			return cb(-1);
		}
	}
	return cb(cnt);
}

function socketWriteAsync(fileData, fileOffset, buf, off, len, cb)
{
	fileData.data.send(buf.subarray(off, off+len));
	return cb(len);
}

var SocketInodeOps = { readAsync: socketReadAsync, writeAsync: socketWriteAsync, commitFileData: null };
var httpSocketInodeOps = { readAsync: socketReadAsync, writeAsync: httpSocketWriteAsync, commitFileData: null };

function cheerpNetOpenSocket(fds, p)
{
	var fileData = new CheerpJFileData(null, null, 0, 0, 0, 0);
	if(cjNetProxy == null)
	{
		fileData.mount = httpSocketInodeOps;
		fileData.currRequest = {
			headers: new Headers(),
			url: "",
			method: "",
			currString: "",
			prevChar: "",
			firstFetchCall: true,
			headersNewLines: 0,
			dataIdx: 0,
			nLines: 0,
		};
	}
	else
	{
		fileData.mount = SocketInodeOps;
	}

	fileData.chunks = [];
	fileData.currData = undefined;

	fileData.currPos = 0;
	fileData.refCount=fileData.refCount+1|0;
	return cheerpOSAllocateFd(fds, fileData);
}

function cheerpNetSocketOpenHandler(e)
{
	var blockedThread = e.target.blockedThread;
	e.target.blockedThread = null;
	cheerpjWakeThreadWithValue(blockedThread, 0);
}

function cheerpNetSocketErrorHandler(e)
{
	var blockedThread = e.target.blockedThread;
	e.target.blockedThread = null;
	cheerpjWakeThreadWithValue(blockedThread, -1);
}

function cheerpNetSocketMessageHandler(e)
{
	var fileData = e.target.cjFileData;
	if(e.data instanceof ArrayBuffer)
		fileData.chunks.push(new Uint8Array(e.data));
	else
		fileData.chunks.push(e.data);
	if(fileData.blockedThread){
		var blockedThread=fileData.blockedThread;
		fileData.blockedThread=null;
		cheerpjWakeThread(blockedThread);
	}
}

function cheerpNetConnectSocket(fds, fd, ipAddr, ipPort, p)
{
	var a={p:p,f:cheerpNetConnectSocket,pc:0,fileDesc:null};
	if(cjNetProxy == null)
	{
		// Pretend that the connection succeeds, we'll try to parse an HTTP session in the write handler.
		return 0;
	}
	if(fd < 0)
		return -1;
	var fileDesc=a.fileDesc=fds[fd];
	if(fileDesc == null)
		return -1;
	var fileData=fileDesc.fileData;
	fileData.data = new WebSocket(cjNetProxy+"/?host="+ipAddr+"&port="+ipPort.toString());
	fileData.data.binaryType = "arraybuffer";
	fileData.data.cjFileData = fileData;
	fileData.data.blockedThread = currentThread;
	fileData.data.onopen = cheerpNetSocketOpenHandler;
	fileData.data.onerror = cheerpNetSocketErrorHandler;
	fileData.data.onmessage = cheerpNetSocketMessageHandler;
	a.pc=0;var ret=cheerpjPauseThread(a);
	return ret;
}

function cheerpNetResolveErrorHandler(e)
{
	var blockedThread = e.target.blockedThread;
	e.target.blockedThread = null;
	cheerpjWakeThreadWithValue(blockedThread, (127<<24)|1);
}

function cheerpNetResolveMessageHandler(e)
{
	var data = e.data;
	var n = data.split(".");
	assert(n.length == 4);
	var ret = 0;
	for(var i=0;i<4;i++){
		ret = ret << 8;
		ret = ret | (n[i]&0xff);
	}
	var blockedThread = e.target.blockedThread;
	e.target.blockedThread = null;
	cheerpjWakeThreadWithValue(blockedThread, ret);
}

function cheerpNetResolveHost(hostName, p)
{
	var a={p:p,f:cheerpNetResolveHost,pc:0};
	if(hostName=='cheerpjhost')
		hostName = "127.0.0.1";
	if(cjNetProxy == null)
		return (192<<24)|(168<<16)|(1<<8)|1;
	var ws = new WebSocket(cjNetProxy+"/resolve?host="+hostName);
	ws.blockedThread = currentThread;
	ws.onerror = cheerpNetResolveErrorHandler;
	ws.onmessage = cheerpNetResolveMessageHandler;
	a.pc=0;var ret=cheerpjPauseThread(a);
	return ret;
}

var cheerpOSMimeMap = { htm: "text/html", html: "text/html", jpeg: "image/jpeg", jpg: "image/jpeg", pdf: "application/pdf", png: "image/png", rtf: "application/rtf", xml: "text/xml" };

function cheerpOSGetFileBlob(fds, path, p)
{
	;
	var a={p:p,f:cheerpOSGetFileBlob,pc:0,blob:null,fds:fds,path:path};
	a.pc=0;var fd=cheerpjOpenAsync(fds, path, "r", a);
	if(fd < 0){
		return null;
	}
	var fileData = fds[fd].fileData;
	assert(fileData.chunks);
	var mimeType = null;
	var extIndex = path.lastIndexOf(".");
	if(extIndex >= 0){
		var ext = path.substr(extIndex+1);
		var m = cheerpOSMimeMap[ext];
		if(m)
			mimeType = m;
	}
	var blob=a.blob=new Blob(fileData.chunks);
	a.pc=1;cheerpjCloseAsync(fds, fd);
	// Slice out excess bytes
	return blob.slice(0, fileData.length, mimeType);
}

function cheerpOSWatchFiles(prefix, cb)
{
	var prefix = cheerpjNormalizePath(prefix)
	if(cb == null)
		delete cosFileWatchPrefixes[prefix];
	else
		cosFileWatchPrefixes[prefix] = cb;
}

function cheerpjGetFileDesc(fds, fd, p)
{
	var fdObj = fds[fd];
	assert(fdObj);
	return fdObj;
}

function cheerpjPauseThread(p)
{
	var thisThread = currentThread;
	buildContinuations(p, false);
	currentThread.state = "BLOCKED_WAIT";
	throw "CheerpJContinue";
}

function cheerpjWakeThread(t)
{
	// It is allowed for a single thread to wait on multiple fds at the same time
	// Only change the state for the first one
	if(t.state == "BLOCKED_WAIT")
	{
		t.state = "READY";
		cheerpjRemoveTimer(t);
		if(!currentThread)
			cheerpjSchedule();
	}
}

function cheerpjWakeThreadWithValue(t, retValue)
{
	t.state = "READY";
	t.retValue = retValue;
	cheerpjSchedule();
}

function cjGetRuntimeResources()
{
	return JSON.stringify(cheerpjRuntimeResources);
}

function cheerpOSRunFunction(t, func)
{
	var args = [].splice.call(arguments, 2);
	// Append a final null for recoverable functions
	// TODO: This effectively makes it not possible to call variadic functions
	args.push(null);
	var promise = cheerpjPromiseAdapter();
	t.continuationStack.unshift({func:function(args){
		func.apply(null, args);
	},args:args});
	t.continuationStack.unshift({func:icheerpjPromiseResolve, args:{pc:0,f:icheerpjPromiseResolve,promise:promise}});
	if(t.state == "PAUSED")
		t.state = "READY";
	cheerpjSchedule();
	return promise;
}
