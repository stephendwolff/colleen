
'use strict';

var soundOptions = {

  baseUrl : 'http://s3.amazonaws.com/weneedus/audio/wnu',
  //baseUrl : 'audio/wnu',
  pathToSoundset: 'client/audio/wnu',

  extension : 'mp3',
  sceneLayersMixMode: 1, // 0 = keep one, 1 = all off
  crossfadeSec : 2.5,
  mixBusVolume : 0
};


module.exports = {
  soundOptions: soundOptions
};
