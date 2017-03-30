//angular-toArrayFilter : to make Angular support objects as well as arrays
angular.module('WebApp', [])
    .controller('WebAppController', ['$scope', function ($scope) {


        //to access AWS, config in ~/.aws/credentials. Before that, credentials must be created in IAM web console , and rights on resources must be given to the user owning the credentials



        //var simu = this;


        $scope.things = []; //properties of a thing : thingName, thingTypeName, selected, state, reported, desired, device
        $scope.thingTypes = [];
        $scope.thingTypeIndex = null;
        $scope.thingIndex = null;
        $scope.propertyIndex = null;
        $scope.newThing = {
            "thingName": "",
            "thingTypeName": ""
        };
        $scope.newThingTypeName = "";
        $scope.newPropertyName = "";
        $scope.texts = [];
        $scope.copies = {};
        $scope.dataGenerator = {}; //properties : idToClearInterval, rate   
        $scope.logs = "";
        $scope.sentUpdates = 0;
        $scope.receivedUpdates = 0;
        $scope.qos = null;
        $scope.allowedQos = ["0", "1", "2"];
        $scope.AWSCredentials = null; //accessKeyId,secretAccessKey
        $scope.parseJSON = function (text) {
            return JSON.parse(text);
        }

        //connection to things registry though aws sdk
        var iot = null;
        var mqttClient = null;


        /**
         * utilities to do sigv4
         * @class SigV4Utils
         */
        function SigV4Utils() {}

        SigV4Utils.getSignatureKey = function (key, date, region, service) {
            var kDate = AWS.util.crypto.hmac('AWS4' + key, date, 'buffer');
            var kRegion = AWS.util.crypto.hmac(kDate, region, 'buffer');
            var kService = AWS.util.crypto.hmac(kRegion, service, 'buffer');
            var kCredentials = AWS.util.crypto.hmac(kService, 'aws4_request', 'buffer');
            return kCredentials;
        };

        SigV4Utils.getSignedUrl = function (host, region, credentials) {
            var datetime = AWS.util.date.iso8601(new Date()).replace(/[:\-]|\.\d{3}/g, '');
            var date = datetime.substr(0, 8);

            var method = 'GET';
            var protocol = 'wss';
            var uri = '/mqtt';
            var service = 'iotdevicegateway';
            var algorithm = 'AWS4-HMAC-SHA256';

            var credentialScope = date + '/' + region + '/' + service + '/' + 'aws4_request';
            var canonicalQuerystring = 'X-Amz-Algorithm=' + algorithm;
            canonicalQuerystring += '&X-Amz-Credential=' + encodeURIComponent(credentials.accessKeyId + '/' + credentialScope);
            canonicalQuerystring += '&X-Amz-Date=' + datetime;
            canonicalQuerystring += '&X-Amz-SignedHeaders=host';

            var canonicalHeaders = 'host:' + host + '\n';
            var payloadHash = AWS.util.crypto.sha256('', 'hex')
            var canonicalRequest = method + '\n' + uri + '\n' + canonicalQuerystring + '\n' + canonicalHeaders + '\nhost\n' + payloadHash;

            var stringToSign = algorithm + '\n' + datetime + '\n' + credentialScope + '\n' + AWS.util.crypto.sha256(canonicalRequest, 'hex');
            var signingKey = SigV4Utils.getSignatureKey(credentials.secretAccessKey, date, region, service);
            var signature = AWS.util.crypto.hmac(signingKey, stringToSign, 'hex');

            canonicalQuerystring += '&X-Amz-Signature=' + signature;
            if (credentials.sessionToken) {
                canonicalQuerystring += '&X-Amz-Security-Token=' + encodeURIComponent(credentials.sessionToken);
            }

            var requestUrl = protocol + '://' + host + uri + '?' + canonicalQuerystring;
            return requestUrl;
        };

        var thingsListRetrieved = false;
        var connectedToBroker = false;




        ////////////////////////////////////////
        //////    MQTT
        ////////////////////////////////////////

        // called when the client connects
        function onConnect() {
            // Once a connection has been made, make a subscription and send a message.
            console.log("onConnect");
            connectedToBroker = true;
            subscribe();
        }





        // called when the client loses its connection
        function onConnectionLost(responseObject) {
            if (responseObject.errorCode !== 0) {
                console.log("onConnectionLost:" + responseObject.errorMessage);
            }
        }

        // called when a message arrives
        function onMessageArrived(message) {
            console.log("onMessageArrived. Topic : " + message.destinationName + " , payload : " + message.payloadString);
            processIncomingMessages(message.destinationName, message.payloadString);
        }

        /*        $scope.updateModel = function(variable,value){
                    $scope.variable = value
                    $scope.apply()
                }*/

        //On récupère la liste des device via l'API AWS IoT (pas dispo dans SDK) 

        //        $scope.log = function (text) {
        //            $scope.logs += "\n" + moment().format() + " " + text;
        //
        //        }



        function subscribe() {
            if (thingsListRetrieved && connectedToBroker)
                for (i = 0; i < $scope.things.length; i++) {
                    var subscribeOptions = {
                        qos: 0,
                        onSuccess: function (response) {
                            console.log('Subsribed, granted QoS : ' + response.grantedQos[0])
                        }
                    }
                    mqttClient.subscribe('$aws/things/' + $scope.things[i].thingName + '/shadow/#', subscribeOptions);
                }
        }


        $scope.listThings = function () {
            $scope.things = [];
            $scope.thingTypeIndex = null;
            $scope.thingIndex = null;
            iot.listThings({}, function (err, data) {
                if (err) {
                    console.log(err);

                    //$scope.log(err);
                } else {
                    //$scope.log('Retrieved things list from things registry on AWS : '+JSON.stringify(data));
                    //$scope.log('number of things '+data.things.length)
                    for (i = 0; i < data.things.length; i++) {
                        //$scope.log('the thing is '+data.things[i].thingName)
                        $scope.things.push(data.things[i]);
                        $scope.things[i]['state'] = [];
                        $scope.things[i]['reported'] = [];
                        $scope.things[i]['desired'] = [];


                        //we create one connection per device to be more realistic, even if one client id for all things name (used in topic paths) is allowed by AWS. In contrast, one certificate is shared among all connections, because handling certificates is a bit heavier.
                        //$scope.log('creating a connection for thing '+data.things[i].thingName)
                        //                        $scope.things[i]['device'] = devicesdk.device({
                        //                            keyPath: "c84c370d61-private.pem.key",
                        //                            certPath: "c84c370d61-certificate.pem.crt",
                        //                            caPath: "rootCA.pem.crt",
                        //                            clientId: data.things[i].thingName,
                        //                            region: "us-west-2"
                        //                        });
                        //                        $scope.$apply()
                        //                            //actions performed on receiving MQTT messages
                        //                        $scope.things[i].device
                        //                            .on('message', $scope.processIncomingMessages);
                        //
                        //                        //MQTT connect the thing to AWS IoT
                        //                        //IIFE is necessary to store the thing reference used by the inner callbacks 
                        //                        (function () {
                        //                            var thing = $scope.things[i];
                        //                            thing.device
                        //                                .on('connect', function () {
                        //                                    if (thing) {
                        //                                        //$scope.log('MQTT connected');
                        //                                        //$scope.log('want to subscribe to topics for thing '+thing.thingName);
                        //                                        var topic = '$aws/things/' + thing.thingName + '/shadow/#';
                        //                                        //subscribe is async so we have to wait the callback is fired before publishing (otherwise we may not receive responses to our first requests)
                        //                                        thing.device.subscribe(topic, {
                        //                                            qos: parseInt($scope.qos)
                        //                                        }, function (err, granted) {
                        //                                            if (err) $scope.log('Error on subscribing : ' + err);
                        //                                            //$scope.log('subscribed topics : '+JSON.stringify(granted));
                        //                                            //get properties-values with MQTT                                                      
                        //                                            thing.device.publish('$aws/things/' + thing.thingName + '/shadow/get', null, {
                        //                                                qos: parseInt($scope.qos)
                        //                                            });
                        //
                        //                                        });
                        //                                    }
                        //
                        //                                });
                        //                        })();



                    }
                    $scope.buildThingTypeIndex();
                    $scope.buildThingIndex();
                    $scope.$apply();
                    thingsListRetrieved = true;
                    subscribe();


                }
            })
        }


        $scope.buildThingTypeIndex = function () {
            //$scope.log('building thing type index')
            $scope.thingTypeIndex = {}
            for (var i = 0; i < $scope.things.length; i++) {
                if (!$scope.thingTypeIndex[$scope.things[i].thingTypeName]) {
                    $scope.thingTypeIndex[$scope.things[i].thingTypeName] = [];
                }
                $scope.thingTypeIndex[$scope.things[i].thingTypeName].push(i);

            }
            //$scope.log('thing type index '+JSON.stringify($scope.thingTypeIndex))
        }


        $scope.buildThingIndex = function () {
            //$scope.log('building thing index');
            $scope.thingIndex = {};
            for (var i = 0; i < $scope.things.length; i++) {
                $scope.thingIndex[$scope.things[i].thingName] = i;
            }
            //$scope.log('thing  index : '+JSON.stringify($scope.thingIndex))

        }




        //gives the thing type index based on the thing type name
        $scope.getThingTypeIndex = function (name) {
            return $scope.thingTypeIndex[name];
        }

        $scope.getThingIndex = function (name) {
            return $scope.thingIndex[name];
        }









        $scope.set = function () {
            for (var i = 0; i < $scope.things.length; i++) {
                var doc = {
                    state: {}
                };
                doc.state = {
                    desired: {}
                };
                for (var j = 0; j < $scope.things[i].state.length; j++) {
                    doc.state.desired[$scope.things[i].state[j].propName] = $scope.things[i].state[j].propValue;
                }
                var message = new Paho.MQTT.Message(JSON.stringify(doc));
                message.destinationName = '$aws/things/' + $scope.things[i].thingName + '/shadow/update';
                message.qos = 1;
                mqttClient.send(message);
            }
        }









        function processIncomingMessages(topic, payload) {

            var regexThingName = /aws\/things\/(.*)\/shadow/;

            var thingName = topic.match(regexThingName)[1];

            var thingIndex = $scope.getThingIndex(thingName);
            var thing = $scope.things[thingIndex];


            //if the thing still exists
            if (thing) {

                if (topic.match(/get\/accepted/) != null) {
                    var data = JSON.parse(payload);

                    for (var prop in data.state.desired) {

                        var foundInState = false;
                        var foundInDesired = false;

                        for (var i = 0; i < thing.state.length; i++) {
                            if (thing.state[i].propName == prop) {
                                foundInState = true;
                                break;
                            }
                        }
                        if (!foundInState) {
                            thing['state'].push({
                                propName: prop,
                                propValue: data.state.desired[prop]
                            });
                        }
                        for (var i = 0; i < thing.desired.length; i++) {
                            if (thing.desired[i].propName == prop) {
                                foundInDesired = true;
                                break;
                            }
                        }
                        if (!foundInDesired) {
                            thing['desired'].push({
                                propName: prop,
                                propValue: data.state.desired[prop]
                            });
                        }

                    }
                    for (var prop in data.state.reported) {

                        var foundInReported = false;
                        for (var i = 0; i < thing.reported.length; i++) {
                            if (thing.reported[i].propName == prop) {
                                foundInReported = true;
                                break;
                            }
                        }
                        if (!foundInReported) {
                            thing['reported'].push({
                                propName: prop,
                                propValue: data.state.reported[prop]
                            });
                        }
                        //if the prop is not in desired, it must be created in state, based on reported, so that we can push it to the things shadow
                        var foundInDesired = false;
                        for (var i = 0; i < thing.desired.length; i++) {
                            if (thing.reported[i].propName == prop) {
                                foundInReported = true;
                                break;
                            }
                        }
                        if (!foundInDesired) {
                            thing['state'].push({
                                propName: prop,
                                propValue: ""
                            });
                        }


                    }


                }


                if (topic.match(/update\/accepted/) != null) {
                    $scope.receivedUpdates++;
                    var data = JSON.parse(payload);

                    for (var prop in data.state.reported) {

                        var foundInReported = false;

                        for (var i = 0; i < thing.reported.length; i++) {
                            if (thing.reported[i].propName == prop) {
                                foundInReported = true;
                                thing['reported'][i] = {
                                    propName: prop,
                                    propValue: data.state.reported[prop]
                                };
                                break;
                            }
                        }
                        if (!foundInReported) {
                            thing['reported'].push({
                                propName: prop,
                                propValue: data.state.reported[prop]
                            });
                        }
                    }

                    for (var prop in data.state.desired) {
                        var foundInDesired = false;
                        for (var i = 0; i < thing.desired.length; i++) {
                            if (thing.desired[i].propName == prop) {
                                foundInDesired = true;
                                thing['desired'][i] = {
                                    propName: prop,
                                    propValue: data.state.desired[prop]
                                };
                                break;
                            }
                        }
                        if (!foundInDesired) {
                            thing['desired'].push({
                                propName: prop,
                                propValue: data.state.desired[prop]
                            });
                        }



                    }


                }






            }
            $scope.$apply();
        }




        //simulator start
        $scope.start = function () {
            if (!($scope.qos in $scope.allowedQos)) {
                //$scope.log('Select QoS');
            } else {

                var config = {
                    accessKeyId: $scope.AWSCredentials.accessKeyId.toString(),
                    secretAccessKey: $scope.AWSCredentials.secretAccessKey.toString()
                };
                AWS.config.update(config);
                AWS.config.region = 'us-west-2';
                iot = new AWS.Iot();
                //$scope.listThingTypes();
                //retrieve thing types list from the things registry on AWS
                $scope.listThings();

                //MQTT
                var requestUrl = SigV4Utils.getSignedUrl("anmbfjfo981en.iot.us-west-2.amazonaws.com", "us-west-2", $scope.AWSCredentials);

                // Create a mqtt client instance
                mqttClient = new Paho.MQTT.Client(requestUrl, "webapp");
                // set callback handlers
                mqttClient.onConnectionLost = onConnectionLost;
                mqttClient.onMessageArrived = onMessageArrived;

                var connectOptions = {
                    onSuccess: function () {
                        console.log('Connected to broker');
                        onConnect();
                    },
                    useSSL: true,
                    timeout: 3,
                    mqttVersion: 4,
                    onFailure: function () {
                        console.log('Could not connect to broker')
                    }
                };
                mqttClient.connect(connectOptions);
            }

        }






    }])