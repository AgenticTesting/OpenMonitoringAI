from colorit import color_front

def print_message(message, message_color):
    """
    Prints message in a given color
    """
    if message_color == 'red':
        print(color_front(f"{message}", 255, 0, 0))
    elif message_color == 'green':
        print(color_front(f"{message}", 0, 255, 0))
