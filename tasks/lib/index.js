'use strict';

var ejs = require('ejs');
var dateformat = require('dateformat');
var crypto = require('crypto');
var async = require('async');
var fs = require("fs");
var chalk = require('chalk');
var path = require('path');
var mkdirp = require('mkdirp');

var exec;


ejs.open = "{{";
ejs.close = "}}";

var cwd = __dirname;

var createFile = function (template, options) {
    var outerMetadata = fs.readFileSync(path.resolve(cwd, '../template/' + template)).toString();
    var metadata = ejs.render(outerMetadata, options);
    return metadata;
};

var md5 = function (str) {
    var hash = crypto.createHash('md5');
    return hash.update(str).digest('hex');
};

var sha1 = function (str) {
    var hash = crypto.createHash('sha1');
    return hash.update(str).digest('hex');
};

var save = function (fileContent, pomDir, fileName) {
    mkdirp.sync(pomDir);
    fs.writeFileSync(pomDir + '/' + fileName, fileContent);
    fs.writeFileSync(pomDir + '/' + fileName + '.md5', md5(fileContent));
    fs.writeFileSync(pomDir + '/' + fileName + '.sha1', sha1(fileContent));
};

var directoryExists = function(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch (e) {
        // error is thrown by statSync when path does not exist
        if (e.code === 'ENOENT') {
            return false
        }
        throw e;
    }
};

var createAndUploadArtifacts = function (options, done) {
    var pomDir = options.pomDir || 'test/poms';

    options.parallel = options.parallel === undefined ? false : options.parallel;
    if (!directoryExists(pomDir)) {
        fs.mkdirSync(pomDir);
    }


    save(createFile('project-metadata.xml', options), pomDir, 'outer.xml');
    save(createFile('latest-metadata.xml', options), pomDir, 'inner.xml');
    save(createFile('pom.xml', options), pomDir, 'pom.xml');


    var upload = function (fileLocation, targetFile) {
        var uploadArtifact = function (cb) {
            var targetUri = options.url + '/' + targetFile, status = '';
            if (!options.quiet) {
                console.log(chalk.blue('Uploading to ' + targetUri + "\n\n"));
            }

            var curlOptions = [
                '--silent',
                '--write-out', '"%{http_code}"',
                '--upload-file', fileLocation,
                '--noproxy', options.noproxy ? options.noproxy : '127.0.0.1',
                '--fail'
            ];

            if (options.auth) {
                curlOptions.push('-u');
                curlOptions.push('"'+options.auth.username + ":" + options.auth.password+'"');
            }

            if (options.insecure) {
                curlOptions.push('--insecure');
            }

            var execOptions = {};
            options.cwd && (execOptions.cwd = options.cwd);

            var curlCmd = ['curl', curlOptions.join(' '), targetUri].join(' ');

            var childProcess = exec(curlCmd, execOptions, function (error) {
                if (error) {
                    console.log(chalk.red(error));
                }
            });
            childProcess.stdout.on('data', function (data) {
                status = data;
            });
            childProcess.on('close', function (code) {
                if (status.substring(0, 1) === "2" && code === 0) {
                    cb(null, "Ok");
                } else  {
                    cb("Status code " + status + " and exit code " + code + " for " + targetUri, null);
                }
            });
        };
        return uploadArtifact;
    };


    var artifactStream = fs.createReadStream(options.artifact);
    var md5Hash = crypto.createHash('md5');
    var sha1Hash = crypto.createHash('sha1');

    artifactStream.on('data', function(chunk) {

        var binaryChunk = chunk.toString('binary');

        md5Hash.update(binaryChunk);
        sha1Hash.update(binaryChunk);
    });

    artifactStream.on('error', function(error) {
        console.log(chalk.red(error));
        done(error);
    });

    artifactStream.on('end', function() {

        fs.writeFileSync(pomDir + '/artifact.' + options.packaging + '.md5', md5Hash.digest('hex'));
        fs.writeFileSync(pomDir + '/artifact.' + options.packaging + '.sha1', sha1Hash.digest('hex'));

        var uploads = {};

        var groupIdAsPath = options.groupId.replace(/\./g, "/");
        var groupArtifactPath = groupIdAsPath + '/' + options.artifactId;

        uploads[pomDir + "/outer.xml"] = groupArtifactPath + '/' + 'maven-metadata.xml';
        uploads[pomDir + "/outer.xml.sha1"] = groupArtifactPath + '/' + 'maven-metadata.xml.sha1';
        uploads[pomDir + "/outer.xml.md5"] = groupArtifactPath + '/' + 'maven-metadata.xml.md5';

        var SNAPSHOT_VER = /.*SNAPSHOT$/i;

        var groupArtifactVersionPath = groupArtifactPath + '/' + options.version;
        if (SNAPSHOT_VER.test(options.version)) {
            uploads[pomDir + "/inner.xml"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml';
            uploads[pomDir + "/inner.xml.sha1"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.sha1';
            uploads[pomDir + "/inner.xml.md5"] = groupArtifactVersionPath + '/' + 'maven-metadata.xml.md5';
        }

        var remoteArtifactName = options.artifactId + '-' + options.version;
        uploads[pomDir + "/pom.xml"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom';
        uploads[pomDir + "/pom.xml.sha1"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom.sha1';
        uploads[pomDir + "/pom.xml.md5"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.pom.md5';


        if(options.classifier) {
            remoteArtifactName = remoteArtifactName + "-" + options.classifier;
        }
        uploads[options.artifact] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging;
        uploads[pomDir + "/artifact." + options.packaging + ".sha1"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging + '.sha1';
        uploads[pomDir + "/artifact." + options.packaging + ".md5"] = groupArtifactVersionPath + '/' + remoteArtifactName + '.' + options.packaging + '.md5';


        var fns = [];
        for (var u in uploads) {
            if (uploads.hasOwnProperty(u)) {
                fns.push(upload(u, uploads[u]));
            }
        }

        var asyncFn = options.parallel ? async.parallel : async.series;
        asyncFn(fns, function (err) {
            if (!options.quiet) {
                console.log(chalk.blue('-------------------------------------------\n'));
                if (err) {
                    console.log(chalk.red('Artifact Upload failed\n' + String(err)));
                } else {
                    console.log(chalk.green('Artifacts uploaded successfully'));
                }
            }
            done(err);
        });

    });

};

module.exports = function (options, cb) {
    if (!options) {
        throw {name: "IllegalArgumentException", message: "upload artifact options required."};
    }
    exec = process.env.MOCK_NEXUS ? require('./mockexec') : require('child_process').exec;
    options.lastUpdated = process.env.MOCK_NEXUS ? '11111111111111': dateformat(new Date(), "yyyymmddHHMMss");
    createAndUploadArtifacts(options, cb);
};
