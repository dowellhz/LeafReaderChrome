const reader = chrome.runtime.getURL('reader.html');
document.querySelector('#read').onclick = async () => { await chrome.runtime.sendMessage({type:'OPEN_ACTIVE_PAGE'}); window.close(); };
document.querySelector('#library').onclick = () => chrome.tabs.create({url:reader});
document.querySelector('#options').onclick = () => chrome.runtime.openOptionsPage();
