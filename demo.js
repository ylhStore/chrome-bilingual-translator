document.querySelector('#add-content').addEventListener('click', () => {
  const paragraph = document.createElement('p');
  paragraph.textContent = 'New ideas often arrive when we stay curious. This paragraph was added after the page had already loaded.';
  document.querySelector('#dynamic-content').append(paragraph);
});
